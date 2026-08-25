// ink.js —— 用户笔迹采集
// 用 Pointer Events 抓电磁笔的笔迹（含压感），用 perfect-freehand 渲染成漂亮的笔触画到 canvas。
// 同时保留原始采样点，供 capture.js 生成 PNG 上传给视觉模型。

import { getStroke } from '../lib/perfect-freehand.js';
import { CONFIG } from './config.js';

export class InkLayer {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    // 当前笔画：[{x,y,pressure}]，落笔到抬笔为一段
    this.currentStroke = [];
    // 所有已完成笔画：[ [{x,y}], [{x,y}], ... ]
    this.strokes = [];
    // 每一笔当时用的笔刷快照（颜色/粗细/参数），跟 strokes 下标一一对应。
    // 撤销/重画靠这个还原"那一笔本来的样子"，不会被后来换笔刷/换颜色影响
    this.strokeBrush = [];
    // 是否正在落笔
    this.drawing = false;
    // 压感是否可用（有些笔报告常数 0/0.5，要兜底）
    this._pressureSeenVariance = false;
    this._lastPressure = 0.5;

    this.onStrokeStart = null; // 回调：开始新笔画
    this.onStrokeAdd = null;   // 回调：当前笔画新增点（用于 idle 计时器刷新）
    this.onStrokeEnd = null;   // 回调：抬笔
  }

  // 监听画布上的指针事件
  attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('pointerleave', (e) => {
      // 笔离开画布但未抬起：保持捕获，不结束笔画（setPointerCapture 会继续送事件）
    });
    // 阻止默认的触摸滚动/缩放干扰
    c.style.touchAction = 'none';
  }

  _accept(e) {
    // 默认接受笔和手指（电磁笔、Apple Pencil、手指都能写）。
    // 设置里的"防误触模式"（或 URL 带 ?penonly）只认笔，手指/手掌触摸一律忽略——
    // 用笔写字时手掌搭在屏幕上会被当成触摸误触发笔画，这个就是治这个的。
    // ?mouse 让鼠标也能画（方便在电脑上不用笔测试）。
    const params = new URLSearchParams(location.search);
    if ((CONFIG.PEN_ONLY || params.has('penonly')) && e.pointerType !== 'pen') return false;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') return true;
    if (params.has('mouse') && e.pointerType === 'mouse') return true;
    return false;
  }

  _pressure(e) {
    // pressure ∈ [0,1]。0 表示悬停/不可用。
    let p = typeof e.pressure === 'number' ? e.pressure : 0.5;
    // 探测压感是否有变化（判断该笔是否支持真实压感）
    if (p > 0 && Math.abs(p - this._lastPressure) > 0.02) {
      this._pressureSeenVariance = true;
    }
    if (p > 0) this._lastPressure = p;
    // 若全程没见过压感变化，给个稳定的中间值，避免线条忽粗忽细
    if (!this._pressureSeenVariance) p = 0.5;
    return Math.max(p, CONFIG.PEN_PRESSURE_FLOOR);
  }

  _onDown(e) {
    if (!this._accept(e)) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    this.drawing = true;
    this.currentStroke = [];
    // 合并事件：拿本帧被合并的所有中间点，避免快速划线断点
    const pts = this._coalesced(e);
    for (const p of pts) this.currentStroke.push(p);
    if (pts.length === 0) this.currentStroke.push(this._point(e));
    this._redrawCurrent();
    this.onStrokeStart?.();
    this.onStrokeAdd?.();
  }

  _onMove(e) {
    if (!this.drawing || !this._accept(e)) return;
    e.preventDefault();
    const pts = this._coalesced(e);
    for (const p of pts) this.currentStroke.push(p);
    if (pts.length === 0) this.currentStroke.push(this._point(e));
    this._redrawCurrent();
    this.onStrokeAdd?.();
  }

  _onUp(e) {
    if (!this.drawing) return;
    e.preventDefault();
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    this.drawing = false;
    if (this.currentStroke.length > 1) {
      this.strokes.push(this.currentStroke);
      this.strokeBrush.push(this._snapshotBrush());
    }
    this.currentStroke = [];
    this.onStrokeEnd?.();
  }

  // 落笔这一刻的笔刷状态快照：颜色/粗细/预设参数 + 压感是不是"模拟"的。
  // 之后不管全局设置怎么变，这一笔重画时都按这份快照来，不会被后来的改动影响。
  _snapshotBrush() {
    return {
      color: CONFIG.INK_COLOR,
      size: CONFIG.BRUSH_SIZE,
      params: CONFIG.BRUSH_PARAMS,
      simulatePressure: !this._pressureSeenVariance,
    };
  }

  _point(e) {
    const rect = this.canvas.getBoundingClientRect();
    // 把客户端坐标换算成 canvas 内部分辨率坐标
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
      pressure: this._pressure(e),
    };
  }

  _coalesced(e) {
    // getCoalescedEvents：一个 pointermove 可能合并了多个高频采样点
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    const out = [];
    for (const ce of list) {
      out.push({
        x: (ce.clientX - rect.left) * sx,
        y: (ce.clientY - rect.top) * sy,
        pressure: this._pressure(ce),
      });
    }
    return out;
  }

  // 把当前笔画实时画到画布。采用"擦整段重画"策略，freehand 轮廓才连续。
  _redrawCurrent() {
    if (CONFIG.BRUSH_PARAMS.chisel) {
      this._fillChiselStroke(this.currentStroke);
      return;
    }
    if (this.currentStroke.length < 2) {
      // 单点：画一个小圆点
      const p = this.currentStroke[0];
      if (p) {
        const ctx = this.ctx;
        ctx.globalAlpha = CONFIG.BRUSH_PARAMS.alpha ?? 1;
        ctx.fillStyle = CONFIG.INK_COLOR;
        ctx.beginPath();
        ctx.arc(p.x, p.y, CONFIG.INK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1; // 别漏到别的绘制（AI回复手写、设置图标等共用同一个 ctx）
      }
      return;
    }
    const outline = getStroke(this.currentStroke, {
      size: CONFIG.BRUSH_SIZE,
      thinning: CONFIG.BRUSH_PARAMS.thinning,
      smoothing: CONFIG.BRUSH_PARAMS.smoothing,
      streamline: CONFIG.BRUSH_PARAMS.streamline,
      simulatePressure: !this._pressureSeenVariance,
    });
    this._fillOutline(outline);
  }

  // 平笔（扁头笔尖）：笔尖本身是一段固定角度、固定长度的"线"，跟着笔迹路径平移扫过去，
  // 不像 perfect-freehand 那样按压感/速度算粗细——顺着笔尖角度写就粗，垂直着写就细，
  // 这个夹角效果才是笔尖真正扫出来的形状，跟压感无关。单点也走这条路（当成两点重合处理）。
  // 不传 brush 就用当前实时设置（正在写的这一笔）；传了就按快照重画（_redrawAll 用）。
  _fillChiselStroke(stroke, brush) {
    const b = brush || this._snapshotBrush();
    const pts = stroke.length >= 1 ? stroke : null;
    if (!pts) return;
    const path = pts.length >= 2 ? pts : [pts[0], pts[0]];
    const rad = (b.params.nibAngleDeg * Math.PI) / 180;
    const half = b.size / 2;
    const dx = Math.cos(rad) * half;
    const dy = Math.sin(rad) * half;
    const ctx = this.ctx;
    ctx.globalAlpha = b.params.alpha ?? 1;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.moveTo(path[0].x + dx, path[0].y + dy);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x + dx, path[i].y + dy);
    for (let i = path.length - 1; i >= 0; i--) ctx.lineTo(path[i].x - dx, path[i].y - dy);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 同样：不传 brush 用当前实时设置，传了就用快照里的颜色/透明度。
  _fillOutline(points, brush) {
    const ctx = this.ctx;
    const b = brush || this._snapshotBrush();
    ctx.globalAlpha = b.params.alpha ?? 1;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    const n = points.length;
    if (n === 0) { ctx.globalAlpha = 1; return; }
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.quadraticCurveTo(x1, y1, mx, my);
    }
    if (n >= 2) ctx.lineTo(points[n - 1][0], points[n - 1][1]);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1; // 别漏到别的绘制
  }

  // 是否有内容（用于 idle 提交判断）
  isEmpty() {
    return this.strokes.length === 0;
  }

  // 清空所有笔画
  clear() {
    this.strokes = [];
    this.strokeBrush = [];
    this.currentStroke = [];
  }

  // 清空所有笔画并把画布也擦干净。跟 clear() 的区别只在于立刻重绘一次——
  // clear() 那个用在饮墨动画收尾处，那里每帧本来就在重画，不需要额外擦。
  clearAll() {
    this.clear();
    this._redrawAll();
  }

  // 撤销最后一笔：写字写错很常见，撤销比整页清空更常用
  undo() {
    if (this.strokes.length === 0) return false;
    this.strokes.pop();
    this.strokeBrush.pop();
    this._redrawAll();
    return true;
  }

  // 清空画布后按"每一笔当时的快照"重画所有已完成笔画（撤销会用到）——
  // 不按当前设置画，不然中途换过笔刷/颜色的话，前面的字会被撤销"带歪"
  _redrawAll() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let i = 0; i < this.strokes.length; i++) {
      const stroke = this.strokes[i];
      const brush = this.strokeBrush[i] || this._snapshotBrush(); // 兜底：理论上总该有
      if (brush.params.chisel) {
        this._fillChiselStroke(stroke, brush);
        continue;
      }
      if (stroke.length < 2) {
        const p = stroke[0];
        if (p) {
          this.ctx.globalAlpha = brush.params.alpha ?? 1;
          this.ctx.fillStyle = brush.color;
          this.ctx.beginPath();
          this.ctx.arc(p.x, p.y, CONFIG.INK_RADIUS, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.globalAlpha = 1;
        }
        continue;
      }
      const outline = getStroke(stroke, {
        size: brush.size,
        thinning: brush.params.thinning,
        smoothing: brush.params.smoothing,
        streamline: brush.params.streamline,
        simulatePressure: brush.simulatePressure,
      });
      this._fillOutline(outline, brush);
    }
  }
}
