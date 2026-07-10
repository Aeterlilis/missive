// app.js —— 墨问主入口 & 状态机
//
// 状态流转（移植自 riddle 的 main.rs State）：
//   LISTENING  → 提交（停笔超时）→ DRINKING
//   DRINKING   → 饮墨动画跑完 → THINKING（若 AI 已首字则直接 REPLYING）
//   THINKING   → AI 首句到达 → REPLYING
//   REPLYING   → 全部写完且流结束 → LINGERING
//   LINGERING  → 停留计时到 → FADING
//   FADING     → 淡出跑完 → 清屏 → LISTENING
//
// 关键巧思：提交时立刻发起 AI 请求，饮墨动画的 ~1s 正好掩盖首字延迟。

import { CONFIG } from './config.js';
import { InkLayer } from './ink.js';
import { strokesToPngBlob, canvasToBlob, postInterpret } from './capture.js';
import { OracleStream } from './oracle.js';
import { Scribe } from './scribe.js';
import { dissolvePass, clearRegion } from './dissolve.js';

const S = {
  LISTENING: 'LISTENING',
  DRINKING: 'DRINKING',
  THINKING: 'THINKING',
  REPLYING: 'REPLYING',
  LINGERING: 'LINGERING',
  FADING: 'FADING',
};

class App {
  constructor() {
    this.canvas = document.getElementById('paper');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.hint = document.getElementById('hint');
    this.debugEl = document.getElementById('debug');
    this.isDebug = new URLSearchParams(location.search).has('debug');

    this.ink = new InkLayer(this.canvas, this.ctx);
    this.scribe = new Scribe(this.ctx);

    this.state = S.LISTENING;
    this.lastInputAt = performance.now();
    this.turnStrokes = [];      // 本轮提交时的笔迹快照（用于饮墨定位）
    this.oracle = null;         // OracleStream
    this.oracleIter = null;
    this.firstSentenceArrived = false;
    this.lingerUntil = 0;
    this.phaseStart = 0;        // 当前阶段起始时间
    this.drinkStage = 0;
    this.fadeStage = 0;
    this.thinkPulseOn = false;
    this.charCount = 0;
    this.replyBox = null;

    this._setupCanvas();
    this._bindInk();
    this._fillPaper();
    // 页面打开就预加载字体（24MB，提前下，避免回答时卡住）
    this.scribe.ensureFont().catch(() => {});
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _setupCanvas() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const setSize = () => {
      this.canvas.width = Math.floor(window.innerWidth * dpr);
      this.canvas.height = Math.floor(window.innerHeight * dpr);
      this._fillPaper();
    };
    setSize();
    window.addEventListener('resize', setSize);
  }

  _fillPaper() {
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _bindInk() {
    this.ink.attach();
    this.ink.onStrokeStart = () => {
      // 用户落笔：隐藏首屏提示；若正处于回答阶段，新落笔即打断（准备新一轮）
      this.hint?.classList.add('fade');
      this.lastInputAt = performance.now();
      if (this.state !== S.LISTENING) {
        this._resetToListening(true);
      }
    };
    this.ink.onStrokeAdd = () => { this.lastInputAt = performance.now(); };
    this.ink.onStrokeEnd = () => { this.lastInputAt = performance.now(); };
  }

  // ─── 主循环 ────────────────────────────────────
  _loop(now) {
    try {
      switch (this.state) {
        case S.LISTENING: this._tickListening(now); break;
        case S.DRINKING: this._tickDrinking(now); break;
        case S.THINKING: this._tickThinking(now); break;
        case S.REPLYING: this._tickReplying(now); break;
        case S.LINGERING: this._tickLingering(now); break;
        case S.FADING: this._tickFading(now); break;
      }
    } catch (e) {
      console.error('主循环异常', e);
      this._dbg('ERR ' + e.message);
    }
    this._dbg();
    requestAnimationFrame(this._loop);
  }

  // ─── LISTENING：等停笔提交 ─────────────────────
  _tickListening(now) {
    if (!this.ink.isEmpty() && !this.ink.drawing && now - this.lastInputAt >= CONFIG.IDLE_COMMIT_MS) {
      this._commit();
    }
  }

  // 提交：截 PNG → 立刻发 AI → 进饮墨
  async _commit() {
    // 快照笔迹（用于饮墨定位），并切换状态，避免重复触发
    this.turnStrokes = this.ink.strokes.map((s) => s.slice());
    this.state = S.DRINKING;
    this.phaseStart = performance.now();
    this.drinkStage = 0;
    this.firstSentenceArrived = false;
    this._gotContent = false;
    this._streamDone = false;

    this._dbg('提交，发起 AI 请求');

    this._oracleFailed = false; // AI 是否已失败（饮墨跑完后据此走兜底）

    // 立刻发起 AI（用饮墨动画掩盖延迟）
    this._startOracle().catch((e) => {
      console.error('AI 请求失败', e);
      this._oracleFailed = true;
      // 不立即抢占饮墨/思考：等 _tickDrinking/_tickThinking 在合适的时机处理
    });
  }

  async _startOracle() {
    const blob = await canvasToBlob(this._captureMain());
    const stream = await postInterpret(blob);
    this.oracle = new OracleStream(stream);
    // 启动独立的消费循环，不依赖主循环轮询，彻底消除时序竞态
    this._consumeOracle();
  }

  // 独立消费 AI 回复的循环：持续读句子 → 喂给 scribe，直到流结束。
  // 不受主循环 tick 影响，避免"pullNext 没被调用"的竞态。
  async _consumeOracle() {
    const iter = this.oracle.sentences();
    this.oracleIter = iter; // 保留引用（调试/兼容旧逻辑）
    try {
      while (true) {
        const { value, done } = await iter.next();
        if (done) break;
        if (value) {
          // 首句到达：从 THINKING 切到 REPLYING
          if (!this._gotContent) {
            this._gotContent = true;
            if (this.state === S.THINKING) {
              this._drawThinkDot(false);
              this.state = S.REPLYING;
            }
          }
          // _pulling 标记 appendText 进行中，阻止 _tickReplying 提前进 LINGERING
          this._pulling = true;
          try {
            await this.scribe.appendText(value, this._replyY);
          } catch (ae) {
            console.error('appendText 失败:', ae.message);
          }
          this._pulling = false;
          this.charCount += value.length;
          const box = this.scribe.replyBBox();
          if (box) this._replyY = box.maxY + 8;
        }
      }
    } catch (e) {
      console.error('消费 AI 回复失败', e);
    }
    this._streamDone = true;
    // 流结束但没收到内容 → 兜底
    if (!this._gotContent && this.state !== S.LINGERING) {
      this._emergencyLine('……风把字吹散了，能再写一遍吗？');
    }
  }

  // 把主画布的笔迹区域裁剪降采样成离屏 canvas（供转 Blob 上传）
  _captureMain() {
    const bbox = strokesBBox(this.ink.strokes);
    const pad = 20;
    const x0 = Math.max(0, bbox.minX - pad), y0 = Math.max(0, bbox.minY - pad);
    const x1 = Math.min(this.canvas.width, bbox.maxX + pad);
    const y1 = Math.min(this.canvas.height, bbox.maxY + pad);
    const w = x1 - x0, h = y1 - y0;
    const longSide = Math.max(w, h);
    const factor = Math.max(CONFIG.PNG_MIN_DOWNSCALE, Math.ceil(longSide / CONFIG.PNG_MAX_LONG_SIDE));
    let ow = Math.max(1, Math.floor(w / factor)), oh = Math.max(1, Math.floor(h / factor));
    // 保底放大：手写识别需要足够清晰度。若降采样后仍太小，放大到至少 400px 长边
    const MIN_LONG = 400;
    if (Math.max(ow, oh) < MIN_LONG) {
      const up = MIN_LONG / Math.max(ow, oh);
      ow = Math.round(ow * up);
      oh = Math.round(oh * up);
    }
    const off = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(ow, oh)
      : Object.assign(document.createElement('canvas'), { width: ow, height: oh });
    const oc = off.getContext('2d');
    oc.imageSmoothingEnabled = false; // 关闭平滑：墨水屏要干脆黑白，放大也保持像素感
    oc.drawImage(this.canvas, x0, y0, w, h, 0, 0, ow, oh);
    return off;
  }

  // ─── DRINKING：饮墨淡出用户字迹 ───────────────
  _tickDrinking(now) {
    const elapsed = now - this.phaseStart;
    const targetStage = Math.min(CONFIG.DRINK_STAGES, Math.floor(elapsed / CONFIG.DRINK_INTERVAL_MS));
    // perfect-freehand 线宽(size≈7)会让墨迹超出采样点包围盒，外扩 padding 覆盖完整笔迹
    const raw = strokesBBox(this.turnStrokes);
    const pad = 16;
    const bbox = {
      minX: Math.max(0, raw.minX - pad),
      minY: Math.max(0, raw.minY - pad),
      maxX: Math.min(this.canvas.width, raw.maxX + pad),
      maxY: Math.min(this.canvas.height, raw.maxY + pad),
    };
    let inkLeft = true;
    while (this.drinkStage < targetStage && inkLeft) {
      inkLeft = dissolvePass(this.ctx, bbox, this.drinkStage, CONFIG.DRINK_STAGES);
      this.drinkStage++;
    }
    // 结束条件：跑满所有阶段，或已经没有墨迹可淡（避免空转造成的"停顿后跳变"）
    const done = this.drinkStage >= CONFIG.DRINK_STAGES || !inkLeft;
    if (done) {
      // 收尾：静默清掉残余（同一区域、同一帧，无可见跳变）
      clearRegion(this.ctx, bbox);
      this.ink.clear();
      this.turnStrokes = [];
      this.phaseStart = now;
      this.scribe.reset();
      this._replyY = CONFIG.layout(this.canvas.width, this.canvas.height).startY;
      // 饮墨跑完后才决定下一步，避免 AI 失败兜底抢占动画
      if (this._oracleFailed) {
        this._emergencyLine('墨迹晕开了……我一时读不出来。');
      } else if (this.firstSentenceArrived) {
        this.state = S.REPLYING;
      } else {
        this.state = S.THINKING;
      }
    }
  }

  // ─── THINKING：安静等待 AI 回复（不画呼吸点，保持画面干净）──
  _tickThinking(now) {
    // 请求已失败 → 立即走兜底，不要干等超时
    if (this._oracleFailed) {
      this._emergencyLine('墨迹晕开了……我一时读不出来。');
      return;
    }
    // 超时给兜底
    if (now - this.phaseStart > CONFIG.ORACLE_PATIENCE_MS) {
      this._emergencyLine('……我走神了，能再说一遍吗？');
    }
    // 不画呼吸点：字被吸走后画面保持干净的白，等待回答自然浮现，更像魔法日记
  }

  _drawThinkDot(on) {
    const cx = Math.round(this.canvas.width / 2);
    const cy = Math.round(this.canvas.height / 2);
    const r = 14;
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2);
    if (on) {
      this.ctx.fillStyle = '#000';
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  // ─── REPLYING：推进手写动画（AI 回复由 _consumeOracle 独立喂入 scribe）──
  _tickReplying(now) {
    this.scribe.step();
    // 写完且流结束 → 停留。
    // !_pulling 保护：appendText 是 async，进行中时 scribe.done 可能短暂为 true
    if (this.scribe.done && this._streamDone && !this._pulling) {
      this.replyBox = this.scribe.replyBBox();
      this.lingerUntil = now + Math.min(
        CONFIG.LINGER_MAX_MS,
        CONFIG.LINGER_BASE_MS + this.charCount * CONFIG.LINGER_PER_CHAR_MS
      );
      this.state = S.LINGERING;
    }
  }

  // 拉 oracle 的下一句，喂给 scribe。流结束置 _streamDone。
  async _pullNext() {
    if (this.firstSentenceArrived === false) this.firstSentenceArrived = true;
    try {
      const { value, done } = await this.oracleIter.next();
      if (done) {
        this._streamDone = true;
        // 流结束但确实一句都没收到（不是 appendText 还在 await 的时序假象）→ 兜底
        if (!this._gotContent && this.state !== S.LINGERING) {
          this._emergencyLine('……风把字吹散了，能再写一遍吗？');
        }
        this._pulling = null;
        return;
      }
      if (value) {
        const len = await this.scribe.appendText(value, this._replyY);
        this.charCount += len;
        this._gotContent = true;  // 真正写入了一句话
        // 更新下一行起点
        const box = this.scribe.replyBBox();
        if (box) this._replyY = box.maxY + 8;
        this.firstSentenceArrived = true;
        if (this.state === S.THINKING) {
          this._drawThinkDot(false);
          this.state = S.REPLYING;
        }
      }
    } catch (e) {
      console.error('拉取回答失败', e);
      this._streamDone = true;
    }
    this._pulling = null;
  }

  // ─── LINGERING：停留展示 ───────────────────────
  _tickLingering(now) {
    if (now >= this.lingerUntil) {
      this.state = S.FADING;
      this.phaseStart = now;
      this.fadeStage = 0;
      this.replyBox = this.scribe.replyBBox();
    }
  }

  // ─── FADING：淡出 AI 回答 ──────────────────────
  _tickFading(now) {
    if (!this.replyBox) { this._resetToListening(false); return; }
    const elapsed = now - this.phaseStart;
    const target = Math.min(CONFIG.FADE_STAGES, Math.floor(elapsed / CONFIG.FADE_INTERVAL_MS));
    while (this.fadeStage < target) {
      dissolvePass(this.ctx, this.replyBox, this.fadeStage, CONFIG.FADE_STAGES);
      this.fadeStage++;
    }
    if (this.fadeStage >= CONFIG.FADE_STAGES) {
      clearRegion(this.ctx, this.replyBox);
      this._fillPaper(); // 整页白底，清残影
      this._resetToListening(false);
    }
  }

  // ─── 工具 ──────────────────────────────────────
  _resetToListening(userInterrupted) {
    this.state = S.LISTENING;
    this.oracle = null;
    this.oracleIter = null;
    this._pulling = null;
    this._streamDone = false;
    this._oracleFailed = false;
    this._gotContent = false;
    this.firstSentenceArrived = false;
    this.charCount = 0;
    this.scribe.reset();
    this.replyBox = null;
    if (!userInterrupted) this.lastInputAt = performance.now();
    // 若用户中途打断，保留当前墨迹，继续计时
  }

  // 兜底：AI 失败/超时时直接写一句固定回复
  async _emergencyLine(text) {
    this._drawThinkDot(false);
    this.scribe.reset();
    this._replyY = CONFIG.layout(this.canvas.width, this.canvas.height).startY;
    const len = await this.scribe.appendText(text, this._replyY);
    this.charCount += len;
    this.state = S.REPLYING;
    this._streamDone = true;
  }

  _dbg(extra) {
    if (!this.isDebug) return;
    if (extra) this._dbgBuf = (this._dbgBuf || '') + extra + '\n';
    this.debugEl.textContent =
      `state=${this.state}\nink=${this.ink.strokes.length}strokes\n` +
      `chars=${this.charCount}\n` + (this._dbgBuf || '').slice(-400);
  }
}

// 笔迹包围盒
function strokesBBox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const s of strokes) for (const p of s) {
    any = true;
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  if (!any) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

// 启动
window.addEventListener('DOMContentLoaded', () => {
  if (new URLSearchParams(location.search).has('debug')) {
    document.body.classList.add('debug');
  }
  window.__app = new App();
});
