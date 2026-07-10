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
    // 接受笔（电磁笔、Apple Pencil 都是 pen）。调试/无笔时用参数放开：
    //   ?mouse  → 鼠标也能写（电脑测试）
    //   ?touch  → 手指也能写（iPad 无 Apple Pencil 时备用）
    const params = new URLSearchParams(location.search);
    const allowMouse = params.has('mouse');
    const allowTouch = params.has('touch');
    if (e.pointerType === 'pen') return true;
    if (allowMouse && e.pointerType === 'mouse') return true;
    if (allowTouch && e.pointerType === 'touch') return true;
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
    }
    this.currentStroke = [];
    this.onStrokeEnd?.();
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
    if (this.currentStroke.length < 2) {
      // 单点：画一个小圆点
      const p = this.currentStroke[0];
      if (p) {
        this.ctx.fillStyle = '#000';
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, CONFIG.INK_RADIUS, 0, Math.PI * 2);
        this.ctx.fill();
      }
      return;
    }
    const outline = getStroke(this.currentStroke, {
      size: 7,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: !this._pressureSeenVariance,
    });
    this._fillOutline(outline);
  }

  _fillOutline(points) {
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    const n = points.length;
    if (n === 0) return;
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
  }

  // 是否有内容（用于 idle 提交判断）
  isEmpty() {
    return this.strokes.length === 0;
  }

  // 清空所有笔画
  clear() {
    this.strokes = [];
    this.currentStroke = [];
  }
}
