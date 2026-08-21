// app.js —— Missive 主入口 & 状态机
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

import { CONFIG, BRUSH_PRESETS } from './config.js';
import { InkLayer } from './ink.js';
import { strokesToPngBlob, canvasToBlob, postInterpret, postInterpretText } from './capture.js';
import { OracleStream } from './oracle.js';
import { Scribe } from './scribe.js';
import { clearRegion } from './dissolve.js';

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
    this.bgCanvas = document.getElementById('bg-layer');
    this.bgCtx = this.bgCanvas.getContext('2d');
    this.hasBgImage = false;
    this._bgRect = null; // 背景图铺满的区域（导入图片后 = 整个画布）
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
      this.bgCanvas.width = this.canvas.width;
      this.bgCanvas.height = this.canvas.height;
      this._fillPaper();
      // 窗口尺寸变了，背景图的像素内容跟着没了（跟笔迹一样，这是已知的小缺陷，先不管）
      this.hasBgImage = false;
      this._bgRect = null;
    };
    setSize();
    window.addEventListener('resize', setSize);
  }

  // 画布本身透明，纸的颜色/纹理是 CSS 画在它下面的，这里只负责清空重来
  _fillPaper() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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
    document.body.classList.toggle('is-listening', this.state === S.LISTENING);
    document.getElementById('btn-clear-bg')?.classList.toggle('hidden', !this.hasBgImage);
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

  // ─── LISTENING：等停笔提交（或手动点发送）──────
  _tickListening(now) {
    if (!CONFIG.AUTO_SEND_ENABLED) return; // 关了自动发送，只能靠手动发送按钮
    const hasContent = !this.ink.isEmpty() || this.hasBgImage;
    if (hasContent && !this.ink.drawing && now - this.lastInputAt >= CONFIG.IDLE_COMMIT_MS) {
      this._commit();
    }
  }

  // 手动发送：写完自己点，不用等自动发送的计时器（两者不冲突，可以共存）。
  // 导入了背景图的话，就算一个字都没在上面写，也能直接发送。
  submitNow() {
    const hasContent = !this.ink.isEmpty() || this.hasBgImage;
    if (this.state !== S.LISTENING || !hasContent || this.ink.drawing) return;
    this._commit();
  }

  // 撤销最后一笔：只在还没提交（LISTENING）时有意义
  undoLastStroke() {
    if (this.state !== S.LISTENING) return;
    this.ink.undo();
  }

  // 提交：截 PNG（背景图+笔迹合成）→ 立刻发 AI → 进饮墨
  async _commit() {
    // 快照笔迹（用于饮墨定位），并切换状态，避免重复触发
    this.turnStrokes = this.ink.strokes.map((s) => s.slice());
    this.state = S.DRINKING;
    this.phaseStart = performance.now();
    this._drinkSnapshot = null;
    this._drinkBgSnapshot = null;
    this.firstSentenceArrived = false;
    this._gotContent = false;
    this._streamDone = false;

    this._dbg('提交，发起 AI 请求');

    this._oracleFailed = false; // AI 是否已失败（饮墨跑完后据此走兜底）

    // 立刻发起 AI（用饮墨动画掩盖延迟）
    this._startOracleFromCanvas().catch((e) => {
      console.error('AI 请求失败', e);
      this._oracleFailed = true;
      // 不立即抢占饮墨/思考：等 _tickDrinking/_tickThinking 在合适的时机处理
    });
  }

  async _startOracleFromCanvas() {
    const blob = await canvasToBlob(this._captureMain());
    await this._startOracleWithBlob(blob);
  }

  async _startOracleWithBlob(blob) {
    const stream = await postInterpret(blob);
    this.oracle = new OracleStream(stream);
    this._consumeOracle();
  }

  async _startOracleFromText(text) {
    const stream = await postInterpretText(text);
    this.oracle = new OracleStream(stream);
    this._consumeOracle();
  }

  // ─── 导入图片：铺成背景层，留在 LISTENING 让用户接着在上面写字 ──
  // 提交（手动/自动）时会跟正常写字一样走 _commit()，把背景图+笔迹合成一张发出去。
  async importImage(file) {
    if (this.state !== S.LISTENING) return;
    this.hint?.classList.add('fade');

    const bitmap = await createImageBitmap(file);
    const cw = this.bgCanvas.width, ch = this.bgCanvas.height;
    this.bgCtx.clearRect(0, 0, cw, ch);
    drawImageCover(this.bgCtx, bitmap, 0, 0, cw, ch); // 居中裁切铺满整个画布，跟手机壁纸一个裁法
    bitmap.close?.();

    this.hasBgImage = true;
    this._bgRect = { minX: 0, minY: 0, maxX: cw, maxY: ch };
    this.lastInputAt = performance.now(); // 自动发送计时器从"导入完成"这一刻重新算
  }

  // 移除已导入但还没提交的背景图，不影响已经写的笔迹
  clearBgImage() {
    if (!this.hasBgImage) return;
    this.bgCtx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    this.hasBgImage = false;
    this._bgRect = null;
  }

  // ─── 打字模式：没有画布内容可淡，直接进"思考中" ──────
  async submitTyped(text) {
    if (this.state !== S.LISTENING || !text.trim()) return;
    this.hint?.classList.add('fade');
    this.state = S.THINKING;
    this.phaseStart = performance.now();
    this.firstSentenceArrived = false;
    this._gotContent = false;
    this._streamDone = false;
    this._oracleFailed = false;
    this._replyY = CONFIG.layout(this.canvas.width, this.canvas.height).startY;
    this._startOracleFromText(text.trim()).catch((e) => {
      console.error('AI 请求失败', e);
      this._oracleFailed = true;
    });
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

  // 把主画布（背景图+笔迹）裁剪降采样成离屏 canvas（供转 Blob 上传）。
  // 有背景图的话直接用整个画布——背景图铺满全屏，裁小了等于把图截没了。
  _captureMain() {
    const bbox = this.hasBgImage ? this._bgRect : strokesBBox(this.ink.strokes);
    const pad = this.hasBgImage ? 0 : 20;
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
    // 主画布本身是透明的（背景是 CSS 纹理），截图给 AI 识别前先垫一层白底，
    // 不管屏幕上用户选的是什么纸张主题，AI 看到的永远是干净的黑字白纸
    oc.fillStyle = '#fff';
    oc.fillRect(0, 0, ow, oh);
    if (this.hasBgImage) oc.drawImage(this.bgCanvas, x0, y0, w, h, 0, 0, ow, oh);
    oc.drawImage(this.canvas, x0, y0, w, h, 0, 0, ow, oh); // 笔迹叠在背景图上面
    return off;
  }

  // ─── DRINKING：饮墨淡出用户字迹（或导入的图片）──
  // 跟 FADING 用的是同一套"整块快照 + 左到右擦除带"（_paintWipedSnapshot），
  // 不用像早期版本那样纠结"按笔画拆分不好办"——反正现在整段一起当一张图处理，
  // 不需要精确拆到每一笔，手写字距不规律也不影响。有背景图的话背景图跟着一起走。
  _tickDrinking(now) {
    // 先原样停留一段时间（跟 AI 回复的 LINGERING 对称），别一提交就立刻开始淡出
    if (now - this.phaseStart < CONFIG.DRINK_LINGER_MS) return;
    if (!this._drinkSnapshot) {
      const bbox = this.hasBgImage ? this._bgRect : (() => {
        const raw = strokesBBox(this.turnStrokes);
        const pad = Math.ceil(CONFIG.BRUSH_SIZE / 2) + 1;
        return {
          minX: Math.max(0, raw.minX - pad),
          minY: Math.max(0, raw.minY - pad),
          maxX: Math.min(this.canvas.width, raw.maxX + pad),
          maxY: Math.min(this.canvas.height, raw.maxY + pad),
        };
      })();
      this._drinkBBox = bbox;
      this._drinkSnapshot = this.ctx.getImageData(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
      this._drinkBgSnapshot = this.hasBgImage
        ? this.bgCtx.getImageData(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)
        : null;
      this._drinkStart = now;
    }

    const t = Math.min(1, (now - this._drinkStart) / CONFIG.DRINK_FADE_MS);
    this._paintWipedSnapshot(this.ctx, this._drinkSnapshot, this._drinkBBox, t);
    if (this._drinkBgSnapshot) this._paintWipedSnapshot(this.bgCtx, this._drinkBgSnapshot, this._drinkBBox, t);

    if (t >= 1) {
      clearRegion(this.ctx, this._drinkBBox);
      if (this.hasBgImage) clearRegion(this.bgCtx, this._drinkBBox);
      this._drinkSnapshot = null;
      this._drinkBgSnapshot = null;
      this._finishDrinking(now);
    }
  }

  // 饮墨阶段收尾：不管走的哪条路径，最后都汇到这里决定下一步
  _finishDrinking(now) {
    this.ink.clear();
    this.turnStrokes = [];
    this._drinkSnapshot = null;
    this._drinkBgSnapshot = null;
    this.hasBgImage = false;
    this._bgRect = null;
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
    this.ctx.clearRect(cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2);
    if (on) {
      this.ctx.fillStyle = '#000';
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  // ─── REPLYING：推进手写动画（AI 回复由 _consumeOracle 独立喂入 scribe）──
  _tickReplying(now) {
    // SCRIBE_FRAME_MS 控制"写字速度"：够久没写才推进一帧，不然每个rAF都写、设置里的
    // 速度滑块不会生效
    if (!this._lastScribeStepAt || now - this._lastScribeStepAt >= CONFIG.SCRIBE_FRAME_MS) {
      this.scribe.step();
      this._lastScribeStepAt = now;
    }
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
      this.replyBox = this.scribe.replyBBox();
      this._fadeSnapshot = null; // 懒加载：进 _tickFading 第一帧再拍快照
    }
  }

  // ─── FADING：淡出 AI 回答 ──────────────────────
  // 整段回复当一张完整快照，用一条从左到右扫过去的"擦除带"抹掉（边缘做羽化过渡，
  // 不是硬边一刀切）。比之前按笔画一片片闪烁顺滑，且总时长就是设置里那个数，
  // 不再摊薄到每一笔头上，不会被笔画数量拖累。
  _tickFading(now) {
    if (!this.replyBox) { this._resetToListening(false); return; }
    if (!this._fadeSnapshot) {
      const bbox = this.replyBox;
      if (bbox.maxX <= bbox.minX || bbox.maxY <= bbox.minY) { this._resetToListening(false); return; }
      this._fadeBBox = bbox;
      this._fadeSnapshot = this.ctx.getImageData(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
      this._fadeStart = now;
    }
    const t = Math.min(1, (now - this._fadeStart) / CONFIG.FADE_DURATION_MS);
    this._paintWipedSnapshot(this.ctx, this._fadeSnapshot, this._fadeBBox, t);

    if (t >= 1) {
      clearRegion(this.ctx, this._fadeBBox);
      this._fadeSnapshot = null;
      this._fillPaper(); // 整页白底，清残影
      this._resetToListening(false);
    }
  }

  // 把快照按 t(0~1) 从左到右"吸走"：整体上还是一条线从左扫到右，
  // 但每个像素的实际擦除位置叠加了一点噪声抖动，边缘揉成不规则的毛边/墨渍状，
  // 不是一把尺子刮过去的硬边擦除——更像纸在啃噬墨迹，而不是被擦掉。
  // DRINKING（用户笔迹/导入图片）、FADING（AI回复）通用同一套。
  _paintWipedSnapshot(ctx, src, bbox, t) {
    const w = src.width, h = src.height;
    const feather = Math.min(200, Math.max(70, w * 0.35));
    const wipeX = t * (w + feather) - feather; // 从 -feather 扫到 w，保证首尾羽化带都完整走一遍
    const noiseCell = 22; // "墨渍"斑块大小：太小会变成雪花噪点，太大会变成大色块
    const jitter = feather * 0.9; // 抖动幅度，相对羽化带宽度定，不会喧宾夺主
    const out = ctx.createImageData(w, h);
    const sd = src.data, od = out.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const localWipeX = wipeX + (smoothNoise(x, y, noiseCell) - 0.5) * jitter;
        let remain;
        if (x < localWipeX) remain = 0;
        else if (x > localWipeX + feather) remain = 1;
        else remain = (x - localWipeX) / feather;
        od[i] = sd[i]; od[i + 1] = sd[i + 1]; od[i + 2] = sd[i + 2];
        od[i + 3] = Math.round(sd[i + 3] * remain);
      }
    }
    ctx.putImageData(out, bbox.minX, bbox.minY);
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
    this._drinkSnapshot = null;
    this._drinkBgSnapshot = null;
    this._fadeSnapshot = null;
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

// 导入图片用："object-fit: cover" 式裁法——居中裁掉多出来的部分，铺满目标区域，不留白边
function drawImageCover(ctx, bitmap, dx, dy, dWidth, dHeight) {
  const srcRatio = bitmap.width / bitmap.height;
  const dstRatio = dWidth / dHeight;
  let sx, sy, sw, sh;
  if (srcRatio > dstRatio) {
    sh = bitmap.height;
    sw = sh * dstRatio;
    sx = (bitmap.width - sw) / 2;
    sy = 0;
  } else {
    sw = bitmap.width;
    sh = sw / dstRatio;
    sx = 0;
    sy = (bitmap.height - sh) / 2;
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dWidth, dHeight);
}

// 确定性伪随机值噪声（同一坐标每次算出来的值不变，不会闪烁）。
// 用来把 AI 回复淡出时那条扫过去的线揉碎成不规则的毛边，
// 看起来更像墨迹被纸吸走，而不是一把尺子刮过去的硬边擦除。
function hash2(ix, iy) {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x, y, cell) {
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); // smoothstep
  const h00 = hash2(x0, y0), h10 = hash2(x0 + 1, y0), h01 = hash2(x0, y0 + 1), h11 = hash2(x0 + 1, y0 + 1);
  const top = h00 + (h10 - h00) * sx;
  const bot = h01 + (h11 - h01) * sx;
  return top + (bot - top) * sy; // 0~1
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

// 字体设置里存的是简称，映射到实际 @font-face 的 font-family 名
const LATIN_FONT_MAP = {
  pinyon: 'Pinyon Script',
  medieval: 'MedievalSharp',
  wenkai: 'LXGW WenKai',
  manufacturing: 'Manufacturing Consent',
  monsieur: 'Monsieur La Doulaise',
  mysoul: 'My Soul',
};

// 预装的中文字体，跟英文字体一样是打包进 fonts/ 的静态 @font-face，不用走上传接口
const CJK_FONT_MAP = {
  default: 'LXGW WenKai',
  liujian: 'Liu Jian Mao Cao',
  zhimang: 'Zhi Mang Xing',
  notoserif: 'Noto Serif SC',
  chunfeng: 'Chill ChunFeng',
};

const CUSTOM_CJK_FAMILY = 'MissiveCustomCJK'; // 不带空格，避免 canvas font 字符串里要不要加引号的麻烦

// 用户传了自定义中文字体的话，运行时动态注册成一个 FontFace，
// 失败（文件坏了/网络问题）就安安静静退回默认的霞鹜文楷，不影响正常写字。
async function loadCjkFont(s) {
  if (s.cjkFont === 'custom' && s.hasCjkFont) {
    try {
      const face = new FontFace(CUSTOM_CJK_FAMILY, `url(/api/cjk-font-file?t=${Date.now()})`);
      await face.load();
      document.fonts.add(face);
      CONFIG.CJK_FONT = CUSTOM_CJK_FAMILY;
      return;
    } catch (e) {
      console.warn('自定义中文字体加载失败，用默认的霞鹜文楷:', e.message);
    }
  }
  CONFIG.CJK_FONT = CJK_FONT_MAP[s.cjkFont] || CJK_FONT_MAP.default;
}

// 拉取运行时设置（写字速度 / 英文字体 / 首屏提示 / 纸张主题），合并进 CONFIG 或直接应用到页面。
// 拉不到就用默认值，不阻塞启动。
async function loadRuntimeConfig() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const s = await res.json();
    if (s.font) CONFIG.LATIN_FONT = LATIN_FONT_MAP[s.font] || LATIN_FONT_MAP.pinyon;
    await loadCjkFont(s);
    // 首屏提示是中文，字体跟设置里选的中文手写字体保持一致，不再写死霞鹜文楷
    document.documentElement.style.setProperty('--hint-font', `"${CONFIG.CJK_FONT}"`);
    // 主题色：设置页那些控件早就在用这个变量了，写字页一直没接——笔刷预设按钮/开关这些也得跟着走
    document.documentElement.style.setProperty('--accent', s.themeColor || '#000000');
    // 界面配色（日夜主题）：工具栏/笔刷面板这些框框的底色+文字颜色，逻辑跟设置页 applyChromeTheme 一样
    {
      const ink = s.chromeInk || '#000000';
      const boxHex = s.chromeBox || '#ffffff';
      const alpha = typeof s.chromeBoxAlpha === 'number' ? s.chromeBoxAlpha : 0.55;
      const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
      const [ir, ig, ib] = hexToRgb(ink);
      const [br, bg, bb] = hexToRgb(boxHex);
      const root = document.documentElement.style;
      root.setProperty('--ink', ink);
      root.setProperty('--ink-faint', `rgba(${ir}, ${ig}, ${ib}, 0.15)`);
      root.setProperty('--box-bg', `rgba(${br}, ${bg}, ${bb}, ${alpha})`);
      root.setProperty('--box-solid', boxHex);
    }
    // 玻璃强度："更透亮"换成更轻的模糊+更高饱和度+边缘高光，逻辑跟设置页 applyGlassIntensity 一样
    if (s.glassIntensity === 'enhanced') {
      let supportsDistortion = false;
      try { supportsDistortion = CSS.supports('backdrop-filter', 'url(#glass-distortion) blur(1px)'); } catch {}
      const root = document.documentElement.style;
      root.setProperty('--box-blur', `${supportsDistortion ? 'url(#glass-distortion) ' : ''}blur(6px) saturate(2)`);
      root.setProperty('--box-rim', 'inset 0 1px 1px rgba(255,255,255,.55), inset 0 -1px 1px rgba(0,0,0,.12)');
    }
    if (typeof s.speed === 'number') {
      const speed = Math.max(1, Math.min(10, s.speed));
      // speed 1(慢)~10(快) → 每帧间隔 30ms~6ms
      CONFIG.SCRIBE_FRAME_MS = Math.round(30 - speed * 2.4);
    }
    if (s.brush) {
      CONFIG.INK_COLOR = s.brush.color || CONFIG.INK_COLOR;
      CONFIG.BRUSH_SIZE = s.brush.size || CONFIG.BRUSH_SIZE;
      CONFIG.BRUSH_PRESET_NAME = s.brush.preset || CONFIG.BRUSH_PRESET_NAME;
      CONFIG.BRUSH_PARAMS = BRUSH_PRESETS[s.brush.preset] || BRUSH_PRESETS.pen;
    }
    CONFIG.AUTO_SEND_ENABLED = s.autoSendEnabled !== false;
    if (typeof s.autoSendSeconds === 'number') {
      CONFIG.IDLE_COMMIT_MS = Math.round(s.autoSendSeconds * 1000);
    }
    if (typeof s.fadeSeconds === 'number') {
      CONFIG.FADE_DURATION_MS = Math.round(s.fadeSeconds * 1000);
    }
    if (typeof s.lingerSeconds === 'number') {
      CONFIG.LINGER_BASE_MS = Math.round(s.lingerSeconds * 1000);
    }
    if (typeof s.inkLingerSeconds === 'number') {
      CONFIG.DRINK_LINGER_MS = Math.round(s.inkLingerSeconds * 1000);
    }
    if (typeof s.inkFadeSeconds === 'number') {
      CONFIG.DRINK_FADE_MS = Math.round(s.inkFadeSeconds * 1000);
    }
    CONFIG.PEN_ONLY = !!s.penOnly;
    renderHint(s.hintText);
    applyTheme(s.theme, s.bgColor);
  } catch (e) {
    console.warn('读取设置失败，用默认值:', e.message);
  }
}

function renderHint(text) {
  const hintEl = document.getElementById('hint');
  if (!hintEl) return;
  const lines = String(text || '用笔在这里写点什么…').split('\n');
  hintEl.innerHTML = lines
    .map((line, i) => (i === 0 ? escapeHtml(line) : `<br /><span style="font-size:18px;opacity:0.7">${escapeHtml(line)}</span>`))
    .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const THEME_CLASSES = ['theme-parchment', 'theme-lined', 'theme-grid', 'theme-xuanzhi', 'theme-watercolor', 'theme-crumpled', 'theme-black', 'theme-custom'];
function applyTheme(theme, bgColor) {
  document.body.classList.remove(...THEME_CLASSES);
  document.body.style.background = ''; // 先清掉上一个主题可能留下的内联背景（自定义图片/纯色都是内联设的）
  if (theme === 'custom') {
    document.body.classList.add('theme-custom');
    document.body.style.backgroundImage = `url(/api/background-image?t=${Date.now()})`;
  } else if (theme === 'solid') {
    document.body.style.background = bgColor || '#ffffff';
  } else if (theme && theme !== 'white') {
    document.body.classList.add('theme-' + theme);
  }
}

// 工具栏 / 导入 / 打字模式的按钮绑定
function bindToolbar(app) {
  const $ = (id) => document.getElementById(id);

  $('btn-undo').addEventListener('click', () => app.undoLastStroke());
  $('btn-send').addEventListener('click', () => app.submitNow());

  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // 允许连续选同一个文件
    if (!file) return;
    try {
      await app.importImage(file);
    } catch (err) {
      console.error('导入图片失败', err);
    }
  });
  $('btn-clear-bg').addEventListener('click', () => app.clearBgImage());

  // ─── 笔刷面板：写字页面里直接调，改了立刻生效并存到后端 ──
  const brushPanel = $('brush-panel');
  const sizePicker = $('brush-size-picker');

  const btnBrush = $('btn-brush');
  btnBrush.addEventListener('click', () => brushPanel.classList.toggle('hidden'));

  // 点面板以外的任何地方（包括画布）就收起来，不然只能靠再点一次🖊关掉，容易一直挡着
  document.addEventListener('pointerdown', (e) => {
    if (brushPanel.classList.contains('hidden')) return;
    if (brushPanel.contains(e.target) || btnBrush.contains(e.target)) return;
    brushPanel.classList.add('hidden');
  });

  function syncBrushUI() {
    sizePicker.value = CONFIG.BRUSH_SIZE;
    document.querySelectorAll('.brush-presets button').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === CONFIG.BRUSH_PRESET_NAME);
    });
    syncColorUI();
  }

  async function saveBrush(partial) {
    const brush = { preset: CONFIG.BRUSH_PRESET_NAME, color: CONFIG.INK_COLOR, size: CONFIG.BRUSH_SIZE, ...partial };
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brush }),
      });
    } catch (err) {
      console.warn('保存笔刷失败', err);
    }
  }

  document.querySelectorAll('.brush-presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const params = BRUSH_PRESETS[preset];
      CONFIG.BRUSH_PRESET_NAME = preset;
      CONFIG.BRUSH_PARAMS = params;
      CONFIG.BRUSH_SIZE = params.defaultSize;
      syncBrushUI();
      saveBrush({ preset, size: CONFIG.BRUSH_SIZE });
    });
  });

  sizePicker.addEventListener('input', () => { CONFIG.BRUSH_SIZE = parseInt(sizePicker.value, 10); });
  sizePicker.addEventListener('change', () => saveBrush({ size: parseInt(sizePicker.value, 10) }));

  // ─── 颜色：预设色块 + 自定义色轮面板 ──────────────
  // 不用原生 <input type="color">：不少浏览器/webview（比如鸿蒙平板自带浏览器）
  // 压根不支持弹出系统调色盘，点了没反应；自己画一个色轮面板哪儿都能用。
  const colorPanel = $('color-panel');
  const svCanvas = $('color-sv');
  const hueCanvas = $('color-hue');
  const wheelCanvas = $('color-wheel');
  const modeSquare = $('color-mode-square');
  const modeTabs = document.querySelectorAll('.color-mode-tab');
  const svCtx = svCanvas.getContext('2d');
  const hueCtx = hueCanvas.getContext('2d');
  const wheelCtx = wheelCanvas.getContext('2d');
  const colorPreview = $('color-preview');
  const colorHex = $('color-hex');
  const btnCustomColor = $('btn-custom-color');
  const presetSwatches = document.querySelectorAll('.color-presets .color-swatch[data-color]');
  const presetColors = Array.from(presetSwatches).map((b) => b.dataset.color.toLowerCase());

  let hue = 0, sat = 0, val = 0; // 面板当前 HSV，只用来画面板；CONFIG.INK_COLOR 才是唯一真源

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  function drawHueStrip() {
    const grad = hueCtx.createLinearGradient(0, 0, hueCanvas.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hueCtx.fillStyle = grad;
    hueCtx.fillRect(0, 0, hueCanvas.width, hueCanvas.height);
  }
  function drawSvSquare() {
    const w = svCanvas.width, h = svCanvas.height;
    const satGrad = svCtx.createLinearGradient(0, 0, w, 0);
    satGrad.addColorStop(0, '#fff');
    satGrad.addColorStop(1, `hsl(${hue},100%,50%)`);
    svCtx.fillStyle = satGrad;
    svCtx.fillRect(0, 0, w, h);
    const valGrad = svCtx.createLinearGradient(0, 0, 0, h);
    valGrad.addColorStop(0, 'rgba(0,0,0,0)');
    valGrad.addColorStop(1, '#000');
    svCtx.fillStyle = valGrad;
    svCtx.fillRect(0, 0, w, h);
    const cx = sat * w, cy = (1 - val) * h;
    svCtx.beginPath();
    svCtx.arc(cx, cy, 5, 0, Math.PI * 2);
    svCtx.strokeStyle = val > 0.6 && sat < 0.6 ? '#000' : '#fff';
    svCtx.lineWidth = 2;
    svCtx.stroke();
  }

  // 色环模式：外圈选色相，内接三角形选饱和度/明度（画画软件常见的那种色轮）
  function wheelGeometry() {
    const w = wheelCanvas.width, h = wheelCanvas.height;
    const cx = w / 2, cy = h / 2;
    const outerR = Math.min(cx, cy) - 2;
    const ringWidth = Math.max(14, outerR * 0.16);
    const innerR = outerR - ringWidth;
    const triR = innerR - 6;
    return { w, h, cx, cy, outerR, innerR, triR };
  }
  function triangleVertices(hueDeg, cx, cy, r) {
    const rad = (deg) => (deg * Math.PI) / 180;
    const aFull = rad(hueDeg), aWhite = aFull + rad(120), aBlack = aFull + rad(240);
    return {
      A: { x: cx + r * Math.cos(aFull), y: cy + r * Math.sin(aFull) }, // 满色（S=1,V=1）
      B: { x: cx + r * Math.cos(aWhite), y: cy + r * Math.sin(aWhite) }, // 白（S=0,V=1）
      C: { x: cx + r * Math.cos(aBlack), y: cy + r * Math.sin(aBlack) }, // 黑（V=0）
    };
  }
  function barycentric(x, y, A, B, C) {
    const denom = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const wA = ((B.y - C.y) * (x - C.x) + (C.x - B.x) * (y - C.y)) / denom;
    const wB = ((C.y - A.y) * (x - C.x) + (A.x - C.x) * (y - C.y)) / denom;
    return [wA, wB, 1 - wA - wB];
  }
  function drawWheel() {
    const { w, h, cx, cy, outerR, innerR, triR } = wheelGeometry();
    const { A, B, C } = triangleVertices(hue, cx, cy, triR);
    const img = wheelCtx.createImageData(w, h);
    const data = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r <= outerR && r >= innerR) {
          let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (ang < 0) ang += 360;
          const [pr, pg, pb] = hsvToRgb(ang, 1, 1);
          data[i] = pr; data[i + 1] = pg; data[i + 2] = pb; data[i + 3] = 255;
        } else if (r < innerR) {
          const [wA, wB, wC] = barycentric(x, y, A, B, C);
          if (wA >= -0.01 && wB >= -0.01 && wC >= -0.01) {
            const s = Math.min(1, Math.max(0, wA));
            const v = Math.min(1, Math.max(0, wA + wB));
            const [pr, pg, pb] = hsvToRgb(hue, s, v);
            data[i] = pr; data[i + 1] = pg; data[i + 2] = pb; data[i + 3] = 255;
          }
        }
      }
    }
    wheelCtx.putImageData(img, 0, 0);

    const markR = (innerR + outerR) / 2;
    const rad = (hue * Math.PI) / 180;
    wheelCtx.beginPath();
    wheelCtx.arc(cx + markR * Math.cos(rad), cy + markR * Math.sin(rad), 5, 0, Math.PI * 2);
    wheelCtx.strokeStyle = '#fff'; wheelCtx.lineWidth = 3; wheelCtx.stroke();
    wheelCtx.strokeStyle = '#000'; wheelCtx.lineWidth = 1; wheelCtx.stroke();

    const pwA = Math.min(1, Math.max(0, sat)), pwB = Math.min(1, Math.max(0, val - sat));
    const pwC = Math.max(0, 1 - pwA - pwB);
    const px = pwA * A.x + pwB * B.x + pwC * C.x, py = pwA * A.y + pwB * B.y + pwC * C.y;
    wheelCtx.beginPath();
    wheelCtx.arc(px, py, 5, 0, Math.PI * 2);
    wheelCtx.strokeStyle = val > 0.6 && sat < 0.6 ? '#000' : '#fff';
    wheelCtx.lineWidth = 2;
    wheelCtx.stroke();
  }

  let wheelZone = null; // 一次拖拽手势内固定在"环"还是"三角形"，防止手指划过边界时选区跳变
  let wheelDragging = false;
  function setFromWheelEvent(e) {
    const { cx, cy, outerR, innerR, triR } = wheelGeometry();
    const rect = wheelCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (wheelCanvas.width / rect.width);
    const y = (e.clientY - rect.top) * (wheelCanvas.height / rect.height);
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (wheelZone === null) wheelZone = r >= innerR ? 'ring' : 'triangle';
    if (wheelZone === 'ring') {
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      hue = ang;
    } else {
      const { A, B, C } = triangleVertices(hue, cx, cy, triR);
      const [wA, wB] = barycentric(x, y, A, B, C);
      sat = Math.min(1, Math.max(0, wA));
      val = Math.min(1, Math.max(0, wA + wB));
    }
    drawWheel();
  }
  wheelCanvas.addEventListener('pointerdown', (e) => {
    wheelZone = null;
    wheelDragging = true;
    try { wheelCanvas.setPointerCapture(e.pointerId); } catch {}
    setFromWheelEvent(e);
    applyCustomColor(false);
  });
  wheelCanvas.addEventListener('pointermove', (e) => {
    if (!wheelDragging) return;
    setFromWheelEvent(e);
    applyCustomColor(false);
  });
  wheelCanvas.addEventListener('pointerup', () => {
    if (!wheelDragging) return;
    wheelDragging = false;
    wheelZone = null;
    applyCustomColor(true);
  });

  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      modeTabs.forEach((t) => t.classList.toggle('active', t === tab));
      const wheelMode = tab.dataset.mode === 'wheel';
      modeSquare.classList.toggle('hidden', wheelMode);
      wheelCanvas.classList.toggle('hidden', !wheelMode);
      if (wheelMode) drawWheel(); else drawSvSquare();
    });
  });

  function applyCustomColor(save) {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    const hex = rgbToHex(r, g, b);
    CONFIG.INK_COLOR = hex;
    colorHex.value = hex;
    colorPreview.style.background = hex;
    syncColorUI();
    if (save) saveBrush({ color: hex });
  }

  function setHueFromEvent(e) {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    hue = (x / rect.width) * 360;
    drawSvSquare();
  }
  function setSvFromEvent(e) {
    const rect = svCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    sat = x / rect.width;
    val = 1 - y / rect.height;
    drawSvSquare();
  }
  function bindDrag(el, onMove) {
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      onMove(e);
      applyCustomColor(false);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      onMove(e);
      applyCustomColor(false);
    });
    el.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      applyCustomColor(true);
    });
  }
  bindDrag(hueCanvas, setHueFromEvent);
  bindDrag(svCanvas, setSvFromEvent);

  btnCustomColor.addEventListener('click', () => {
    const opening = colorPanel.classList.contains('hidden');
    colorPanel.classList.toggle('hidden');
    if (opening) {
      [hue, sat, val] = rgbToHsv(...hexToRgb(CONFIG.INK_COLOR));
      drawHueStrip();
      drawSvSquare();
      drawWheel();
      colorHex.value = CONFIG.INK_COLOR;
      colorPreview.style.background = CONFIG.INK_COLOR;
    }
  });

  colorHex.addEventListener('change', () => {
    let hex = colorHex.value.trim().toLowerCase();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (!/^#[0-9a-f]{6}$/.test(hex)) { colorHex.value = CONFIG.INK_COLOR; return; }
    [hue, sat, val] = rgbToHsv(...hexToRgb(hex));
    drawSvSquare();
    drawWheel();
    CONFIG.INK_COLOR = hex;
    colorPreview.style.background = hex;
    syncColorUI();
    saveBrush({ color: hex });
  });

  presetSwatches.forEach((btn) => {
    btn.addEventListener('click', () => {
      CONFIG.INK_COLOR = btn.dataset.color;
      colorPanel.classList.add('hidden');
      syncColorUI();
      saveBrush({ color: CONFIG.INK_COLOR });
    });
  });

  function syncColorUI() {
    const current = CONFIG.INK_COLOR.toLowerCase();
    const isPreset = presetColors.includes(current);
    presetSwatches.forEach((b) => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === current);
    });
    btnCustomColor.classList.toggle('active', !isPreset);
    btnCustomColor.style.background = isPreset ? '' : current;
  }

  syncBrushUI(); // 笔刷 + 颜色 UI 依赖的 DOM 引用都齐了，这里统一做一次初始同步

  const overlay = $('type-overlay');
  const input = $('type-input');
  const openTyping = () => {
    if (app.state !== S.LISTENING) return;
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
  };
  const closeTyping = () => overlay.classList.add('hidden');
  const sendTyped = async () => {
    const text = input.value.trim();
    if (!text) return;
    closeTyping();
    await app.submitTyped(text);
  };

  $('btn-type').addEventListener('click', openTyping);
  $('type-cancel').addEventListener('click', closeTyping);
  $('type-send').addEventListener('click', sendTyped);
  input.addEventListener('keydown', (e) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTyped();
    }
  });

  // 桌面端小彩蛋：Ctrl+Z 撤销
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && overlay.classList.contains('hidden')) {
      e.preventDefault();
      app.undoLastStroke();
    }
  });
}

// 启动
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).has('debug')) {
    document.body.classList.add('debug');
  }
  await loadRuntimeConfig();
  window.__app = new App();
  bindToolbar(window.__app);
});
