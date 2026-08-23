// scribe.js —— 把 AI 的文字回答"手写"出来：一笔笔在墨水屏上浮现。
//
// 管线（移植自 riddle 的 script.rs，全程纯 JS 整数运算）：
//   1. renderMask(text)  —— 用霞鹜文楷把文字渲染到离屏 canvas，得到黑白位图掩膜
//   2. thin(mask)        —— Zhang-Suen 细化：把笔画瘦身到单像素中线
//   3. trace(mask)       —— 把中线像素连成有序折线，按 x 从左到右排序（"像手写"）
//   4. 主循环每帧从折线里取 N 个点，用小圆点画到可见 canvas 上
//
// 这样看起来就像有一只看不见的手，握着笔沿字的中心线一笔笔描出来。

import { CONFIG } from './config.js';

export class Scribe {
  constructor(targetCtx) {
    this.ctx = targetCtx;            // 可见画布的 2d context（往上面画笔迹）
    this.ink = [];                    // 待写的有序折线：[{x,y}, ...] 已按书写顺序串好
    this.inkIdx = 0;                  // 已经"写"到第几个点
    this.done = true;                 // 当前批是否写完
    this.lines = [];                  // 已渲染文本的行几何（用于淡出时定位区域）
    // 离屏渲染用
    this._off = null;                 // OffscreenCanvas / canvas
    this._octx = null;
    this._fontReady = false;
  }

  async ensureFont() {
    if (this._fontReady) return;
    // 用中等字号加载字体。给 5 秒超时——字体文件大(24MB)时下载慢，
    // 超时就用系统 serif 兜底，绝不让它卡死（否则 Safari 加载条永不消失）
    if (document.fonts && document.fonts.load) {
      try {
        await Promise.race([
          Promise.all([
            document.fonts.load(`64px "${CONFIG.CJK_FONT}"`),
            document.fonts.load(`64px "${CONFIG.LATIN_FONT}"`),
          ]),
          new Promise((_, rej) => setTimeout(() => rej(new Error('字体加载超时')), 5000)),
        ]);
      } catch (e) {
        console.warn('字体未就绪，用 serif 兜底:', e.message);
      }
    }
    // 准备离屏画布（大小无所谓，按需重建）
    this._off = makeOffscreen(8, 8);
    this._octx = this._off.getContext('2d', { willReadFrequently: true });
    this._fontReady = true;
  }

  // 追加一段文字（通常是一句），渲染→细化→trace→接在待写折线后面
  // 返回本次追加的文字长度（用于停留时长计算）
  async appendText(text, startY) {
    await this.ensureFont();
    const cw = this.ctx.canvas.width;
    const ch = this.ctx.canvas.height;
    const L = CONFIG.layout(cw, ch);
    const fontFamily = pickFontFamily(text);
    const wrapped = wrapText(this._octx, text, L.fontPx, cw - 2 * L.marginX, fontFamily);
    let y = startY;
    for (const line of wrapped) {
      // 底部越界检查：如果这行会超出可用区域，停止追加（不再往下写）
      if (y + L.lineHeight > L.maxY) {
        this.done = false;
        return text.length;
      }
      const placed = this._layoutLine(line.text, y, line.width, L, fontFamily);
      y = placed.nextY;
      this.lines.push(placed);
    }
    this.done = false;
    return text.length;
  }

  // 渲染一行文字 → 细化 → trace，把折线加入 this.ink
  _layoutLine(text, y, textWidth, L, fontFamily) {
    const px = L.fontPx;
    // 离屏画一整行
    const W = Math.ceil(textWidth) + 2;
    const H = Math.ceil(px * 1.4) + 2;
    const off = makeOffscreen(W, H);
    const oc = off.getContext('2d', { willReadFrequently: true });
    oc.fillStyle = '#fff';
    oc.fillRect(0, 0, W, H);
    oc.fillStyle = '#000';
    oc.textBaseline = 'top';
    oc.font = `${px}px "${fontFamily}", serif`;
    oc.fillText(text, 1, 1);

    const img = oc.getImageData(0, 0, W, H);
    const mask = toBinaryMask(img);       // Uint8Array，1=墨迹 0=空白
    thin(mask, W, H);                      // Zhang-Suen 细化
    const strokes = trace(mask, W, H);     // [ [{x,y}], ... ] 有序折线

    // 行在可见画布上的水平居中位置
    const canvasW = this.ctx.canvas.width;
    const xOff = Math.round((canvasW - W) / 2);

    // 把这一行的折线（相对行画布的坐标）平移到可见画布坐标，加入待写序列
    for (const s of strokes) {
      const ordered = s.map((p) => ({ x: p.x + xOff, y: p.y + y }));
      this.ink.push(...ordered);
      // 笔画之间空一个"提笔"间隙
      this.ink.push(BREAK);
    }
    return { text, y, nextY: y + L.lineHeight, top: y, height: H, xOff, w: W };
  }

  // 推进一帧：写 N 个点。返回 true 表示全部写完。
  step() {
    if (this.done) return true;
    const ctx = this.ctx;
    const budget = CONFIG.SCRIBE_POINTS_PER_FRAME;
    const r = CONFIG.INK_RADIUS;
    let written = 0;
    ctx.globalAlpha = 1; // AI 回复始终不透明，不受用户笔刷透明度影响
    ctx.fillStyle = CONFIG.INK_COLOR;
    while (written < budget && this.inkIdx < this.ink.length) {
      const p = this.ink[this.inkIdx++];
      if (p === BREAK) { written++; continue; } // 提笔间隙占一个预算
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      written++;
    }
    if (this.inkIdx >= this.ink.length) {
      this.done = true;
    }
    return this.done;
  }

  // 把 ink 按 BREAK 切成一段段（对应 trace() 出来的每条骨架折线），保持书写顺序。
  // "倒放"淡出要用：AI 是怎么一笔一笔写的，这里就原样切出那些"笔画"来。
  getSegments() {
    const segments = [];
    let cur = [];
    for (const p of this.ink) {
      if (p === BREAK) {
        if (cur.length > 0) segments.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (cur.length > 0) segments.push(cur);
    return segments;
  }

  // 取所有已写文字的包围盒（供淡出定位）
  replyBBox() {
    if (this.lines.length === 0) return null;
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;
    const cw = this.ctx.canvas.width;
    for (const l of this.lines) {
      if (l.top < minY) minY = l.top;
      if (l.top + l.height > maxY) maxY = l.top + l.height;
      if (l.xOff < minX) minX = l.xOff;
      if (l.xOff + l.w > maxX) maxX = l.xOff + l.w;
    }
    return {
      minX: Math.max(0, minX - 10),
      minY: Math.max(0, minY - 10),
      maxX: Math.min(cw, maxX + 10),
      maxY: Math.min(this.ctx.canvas.height, maxY + 10),
    };
  }

  // 重置，准备下一轮
  reset() {
    this.ink = [];
    this.inkIdx = 0;
    this.done = true;
    this.lines = [];
  }
}

const BREAK = Symbol('break');

function makeOffscreen(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function innerWidth() {
  return window.innerWidth;
}

// ─── 字体选择 ───────────────────────────────────────────────
// 纯英文（不含中文）用设置里选的字体，含中文的用 CONFIG.CJK_FONT（默认文楷，可被自定义字体覆盖）。
export function pickFontFamily(text) {
  return hasCjk(text) ? CONFIG.CJK_FONT : CONFIG.LATIN_FONT;
}
function hasCjk(text) {
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0))) return true;
  }
  return false;
}

// ─── 文本换行 ───────────────────────────────────────────────
// 按可见宽度把长文本拆成多行。中文按字、英文按词。
function wrapText(ctx, text, px, maxWidth, fontFamily) {
  ctx.font = `${px}px "${fontFamily}", serif`;
  const lines = [];
  let current = '';
  let currentWidth = 0;
  // 先按原始换行/句号处粗分，避免一句很长时换行计算偏差
  const segments = text.split(/(\n)/);
  for (const seg of segments) {
    if (seg === '\n') {
      if (current) { lines.push(commitLine(ctx, current, px)); current = ''; currentWidth = 0; }
      continue;
    }
    // 中文逐字 + 英文按词
    const tokens = tokenize(seg);
    for (const tok of tokens) {
      const w = ctx.measureText(tok).width;
      if (currentWidth + w > maxWidth && current) {
        lines.push(commitLine(ctx, current, px));
        current = tok.replace(/^\s+/, '');
        currentWidth = ctx.measureText(current).width;
      } else {
        current += tok;
        currentWidth += w;
      }
    }
  }
  if (current) lines.push(commitLine(ctx, current, px));
  return lines;
}

function commitLine(ctx, text, px) {
  return { text, width: ctx.measureText(text).width };
}

// 把一段文字切成"中文单字 / 英文单词 / 空白"
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const code = ch.codePointAt(0);
    if (/\s/.test(ch)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else if (isCjk(code) || isFullPunct(ch)) {
      out.push(ch);
      i++;
    } else {
      // 连续的非空白非CJK：当成一个词
      let j = i;
      while (j < s.length) {
        const c2 = s[j];
        if (/\s/.test(c2) || isCjk(c2.codePointAt(0)) || isFullPunct(c2)) break;
        j++;
      }
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function isCjk(code) {
  // CJK 统一表意文字常用区
  return code >= 0x3400 && code <= 0x9fff;
}
function isFullPunct(ch) {
  return '，。、；：？！“”‘’（）【】《》—…·'.includes(ch);
}

// ─── 掩膜二值化 ──────────────────────────────────────────────
// 把 RGBA ImageData 转成 Uint8Array（1=墨迹，0=白）
function toBinaryMask(img) {
  const { data, width, height } = img;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // 亮度阈值：偏暗即算墨迹
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    mask[p] = lum < 128 ? 1 : 0;
  }
  return mask;
}

// ─── Zhang-Suen 细化 ─────────────────────────────────────────
// 经典两阶段迭代骨架化算法。把任意宽度的笔画瘦成单像素中线。
// 参数：mask（Uint8Array，原地修改）、宽、高。
export function thin(mask, w, h) {
  const dirs = [
    [-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1]
  ];
  let changed = true;
  const deleteQ = new Uint8Array(w * h);
  while (changed) {
    changed = false;
    // 两个子迭代
    for (let sub = 0; sub < 2; sub++) {
      deleteQ.fill(0);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (mask[p] === 0) continue;
          // 计算 B（非零邻居数）和 A（顺时针 01 转换数）
          const n = [];
          for (let k = 0; k < 8; k++) {
            const nx = x + dirs[k][0], ny = y + dirs[k][1];
            n.push(mask[ny * w + nx]);
          }
          let B = 0;
          for (let k = 0; k < 8; k++) B += n[k];
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let k = 0; k < 8; k++) {
            if (n[k] === 0 && n[(k + 1) % 8] === 1) A++;
          }
          if (A !== 1) continue;
          // 子迭代条件
          if (sub === 0) {
            if (n[0] * n[2] * n[4] !== 0) continue;
            if (n[2] * n[4] * n[6] !== 0) continue;
          } else {
            if (n[0] * n[2] * n[6] !== 0) continue;
            if (n[0] * n[4] * n[6] !== 0) continue;
          }
          deleteQ[p] = 1;
        }
      }
      for (let i = 0; i < mask.length; i++) {
        if (deleteQ[i]) { mask[i] = 0; changed = true; }
      }
    }
  }
}

// ─── trace：中线像素 → 有序折线 ───────────────────────────────
// 从端点（度=1）起步，贪婪游走邻居；再处理闭合环。丢弃过短碎线。
// 最后所有折线按最小 x 排序，让书写顺序从左到右（"像手写"）。
export function trace(mask, w, h) {
  const remaining = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) remaining[i] = mask[i];

  const isOn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && remaining[y * w + x] === 1;
  const deg = (x, y) => {
    let d = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (isOn(x + dx, y + dy)) d++;
      }
    return d;
  };

  const strokes = [];
  // 之前是 3：字里的点（问号的点、"得"这种字里的短点）细化完往往只剩 1~2 个像素，
  // 连不成"线"，会被当成"碎线"筛掉——改成 1，孤立的点也能正常写出来。
  const minLen = 1;

  // 先从端点（度=1）起步
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isOn(x, y)) continue;
      if (deg(x, y) !== 1) continue;
      const path = walk(x, y);
      if (path.length >= minLen) strokes.push(path);
    }
  }
  // 再处理剩余的闭合环和分叉
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isOn(x, y)) continue;
      const path = walk(x, y);
      if (path.length >= minLen) strokes.push(path);
    }
  }

  // 按每条折线的最小 x 排序
  strokes.sort((a, b) => {
    const ax = a.reduce((m, p) => Math.min(m, p.x), Infinity);
    const bx = b.reduce((m, p) => Math.min(m, p.x), Infinity);
    return ax - bx;
  });
  return strokes;

  // 从 (sx,sy) 贪婪游走，标记走过的像素
  function walk(sx, sy) {
    const path = [{ x: sx, y: sy }];
    remaining[sy * w + sx] = 0;
    let cx = sx, cy = sy;
    for (;;) {
      let nx = -1, ny = -1;
      // 优先直连（上下左右）再斜向，路径更自然
      const order = [[0,-1],[1,0],[0,1],[-1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
      for (const [dx, dy] of order) {
        if (isOn(cx + dx, cy + dy)) { nx = cx + dx; ny = cy + dy; break; }
      }
      if (nx < 0) break;
      path.push({ x: nx, y: ny });
      remaining[ny * w + nx] = 0;
      cx = nx; cy = ny;
    }
    return path;
  }
}
