// appicon.js —— 写字页正中、提示语上方那个可以戳的 app 图标。
//
// 三层手绘素材叠出来的一张画：纸（icon-paper）、纸上的字（icon-line）、羽毛笔（icon-pen）。
// 三张都是 2048 见方的同一块画布，落笔位置本来就对齐，所以同坐标直接叠加就行，
// 不用做任何配准。
//
// 戳一下的编排（因果顺序：被戳的是纸，不是笔）：
//   纸抖 → 笔抬起来 → 纸上旧字淡出 → 笔飞回第一段的落笔点 → 逐段重写，字跟着笔浮现 → 收笔
//
// 素材画的本来就是"刚写完最后一笔"的瞬间（笔尖正停在第四段笔画上），所以静止态
// 不需要任何处理，就是三层原样叠着；戳了才倒回去重写一遍。
//
// 图标不跟纸张主题变色。素材自带的投影本来就是为了在浅色纸上也看得清，放到黑纸
// 主题上就是一张白纸躺在深色桌面上，很自然；反相过来只剩轮廓，反而难看。

// ─── 素材坐标（都是从像素里量出来的，别凭感觉改）──────────────
const SRC = 2048;                      // 素材画布边长

// 笔尖：笔那层最低的不透明像素。整支笔的位置由"笔尖该落在哪"反推。
const NIB = { x: 1312, y: 1088 };

// 纸上那几笔的分段，按书写顺序排。bbox 用来把每段的显现限制在自己的范围内，
// from/to 是这一段的落笔点和收笔点（笔尖沿这条线走，字跟着显现）。
const STROKES = [
  { bbox: [672, 787, 991, 993],     from: [690, 962],  to: [985, 800]  },
  { bbox: [1025, 683, 1229, 793],   from: [1030, 788], to: [1225, 690] },
  { bbox: [830, 857, 1237, 1062],   from: [840, 1052], to: [1232, 864] },
  { bbox: [1240, 1086, 1329, 1132], from: [1245, 1130], to: [1325, 1090] },
];

// 画布四周的出血。素材正好画满 2048 见方，羽毛顶端贴着上边缘（y=71），而写第二段
// 时笔尖要抬到 y=690，整支笔往上平移近 400；换行跳跃时再叠上抬笔高度和抛物线弧顶，
// 最坏约 455。不留出血的话羽毛会被画布边缘齐齐切断。
const BLEED = 560;

// 换行时笔抬起来跳到下一段起点的时长
const JUMP_MS = 90;

// ─── 手感参数（2026-08-23 用预览页调出来的一组）──────────────
export const TUNING = {
  size: 160,      // 图标显示边长上限（CSS px），不含出血。小屏按下面的比例收，见 fitSize()
  sizeRatio: 0.30,// 图标最多占屏幕短边的多少——手机上按 160 显示会大得压住半页纸
  shake: 30,      // 纸抖幅度，素材坐标系
  lift: 72,       // 抬笔高度，素材坐标系
  write: 1100,    // 逐段书写总时长 ms
  fade: 260,      // 旧字淡出时长 ms
  ret: 300,       // 笔从收笔处飞回起点的时长 ms
};

// 实际显示边长：桌面上就是 TUNING.size，屏幕小了按短边比例收。
// 用短边而不是宽度——横过来的手机宽度很够，但高度不够，按宽度算图标会顶掉提示语。
export function fitSize() {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(72, Math.round(Math.min(TUNING.size, shortSide * TUNING.sizeRatio)));
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// 三层素材只解码一次，两个实例（首屏那个大的、等回答时那个小的）共用
let sharedImages = null;

export class AppIcon {
  // onWriteStart：笔落到纸上、开始重写的那一刻回调。提示语换新的那一条就挂在这里，
  //   让图标里的笔和纸上的字在同一时刻开始写。
  // sizeFn：显示边长怎么算，默认跟着屏幕短边缩（见 fitSize）。
  // shakeScale：纸抖的倍率。等回答时那个循环播的小图标给 0——纸抖是"被戳到"的反应，
  //   没人戳它的时候抖就没道理了。
  // standalone：画布自己定位（position:fixed 之类）而不是排在文档流里。这种用法不需要
  //   用负 margin 抵消出血，也没有外层可点区域可以量。
  constructor(canvas, { onWriteStart, sizeFn, shakeScale = 1, standalone = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onWriteStart = onWriteStart || null;
    this.sizeFn = sizeFn || fitSize;
    this.shakeScale = shakeScale;
    this.standalone = standalone;
    this._looping = false;
    this.ready = false;
    this._img = {};
    this._layer = {};
    this._anim = null;
    this._firedWriteStart = false;
    this._dirty = true;          // 需要重画一帧（静止时不必每帧都重画）
    this._dpr = 1;
    this._k = 1;                 // 素材坐标 → 画布像素 的缩放
    this._pad = 0;               // 出血的画布像素数
    this._side = 0;              // 画布边长（含出血）
  }

  async load() {
    if (!sharedImages) {
      const names = { paper: 'img/icon-paper.png', line: 'img/icon-line.png', pen: 'img/icon-pen.png' };
      sharedImages = Promise.all(Object.entries(names).map(([key, src]) => new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve([key, im]);
        im.onerror = () => reject(new Error('图标素材加载失败: ' + src));
        im.src = src;
      }))).then((pairs) => Object.fromEntries(pairs))
        .catch((e) => { sharedImages = null; throw e; });  // 失败了别把错误缓存住，下次还能重试
    }
    this._img = await sharedImages;
    this.ready = true;
    this.resize();
  }

  // 按当前显示尺寸把三层各自预缩一遍。每帧都从 2048 缩一次太浪费，而且缩放质量
  // 逐帧重算反而不稳定。
  resize(size = this.sizeFn()) {
    if (!this.ready) return;
    this._dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const art = Math.round(size * this._dpr);
    this._k = art / SRC;
    this._pad = Math.round(BLEED * this._k);
    this._side = art + this._pad * 2;

    this.canvas.width = this.canvas.height = this._side;
    // 画布带着出血，比图标本身大一圈；用负 margin 抵掉，版面上仍旧只占 size 见方
    this.canvas.style.width = this.canvas.style.height = (this._side / this._dpr) + 'px';
    if (this.standalone) {
      // 自己定位的用法：把出血量交给 CSS，由那边决定怎么抵消（贴边/居中各不一样）
      this.canvas.style.setProperty('--icon-bleed', (this._pad / this._dpr) + 'px');
    } else {
      // 排在文档流里的用法：负 margin 抵掉出血，版面上仍旧只占 size 见方
      this.canvas.style.margin = (-this._pad / this._dpr) + 'px';
      // 外面那层是可点区域，正好一个图标大小——出血是透明的，不该接收点击
      const hit = this.canvas.parentElement;
      if (hit) hit.style.width = hit.style.height = size + 'px';
    }

    for (const key of ['paper', 'line', 'pen']) {
      const c = document.createElement('canvas');
      c.width = c.height = art;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(this._img[key], 0, 0, art, art);
      this._layer[key] = c;
    }
    this._dirty = true;
  }

  get busy() { return !!this._anim; }

  // 可以再戳了吗：正在播的这一遍只要已经落笔开始重写，就允许打断重来——
  // 戳一下要立刻有反应，等它慢慢播完才理人的话就不像被戳了。
  get canPoke() { return !this._anim || this._firedWriteStart; }

  // 从戳下去到笔落纸开始重写之间隔多久。下面那行提示语要赶在这之前退场，
  // 所以退场动画的时长得看这个值。
  get writeDelayMs() {
    return 110 + TUNING.fade * 0.55 + TUNING.ret;
  }

  poke() {
    if (!this.ready) return;
    this._anim = { t0: performance.now(), tl: this._timeline() };
    this._firedWriteStart = false;
  }

  // 一直循环播，当"正在等回答"的指示用：写一遍、抹掉、再写一遍。
  // 停的时候让当前这一遍走完，不会写到一半僵在那里。
  startLoop() {
    this._looping = true;
    if (!this._anim) this.poke();
  }
  stopLoop() { this._looping = false; }

  // 把整段动画的时间点排好。逐段书写的时长按各段长度分配，长的段写得久，
  // 这样笔速看起来是匀的。
  _timeline() {
    const segs = STROKES.map((s) => ({
      ...s,
      len: Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]),
    }));
    const totalLen = segs.reduce((a, s) => a + s.len, 0);
    const items = [];
    let t = 0;
    segs.forEach((s, i) => {
      const d = TUNING.write * (s.len / totalLen);
      items.push({ kind: 'draw', i, s, t0: t, t1: t + d });
      t += d;
      if (i < segs.length - 1) {
        items.push({ kind: 'jump', from: s.to, to: segs[i + 1].from, t0: t, t1: t + JUMP_MS });
        t += JUMP_MS;
      }
    });
    const fadeAt = 110;                              // 抖起来之后再淡出，不然像被擦掉的
    const travelAt = fadeAt + TUNING.fade * 0.55;    // 不等字完全淡干净，笔就先动身，衔接更连贯
    const writeAt = travelAt + TUNING.ret;
    return { items, writeLen: t, shakeDur: 340, liftAt: 110, fadeAt, travelAt, writeAt, total: writeAt + t + 140 };
  }

  // 由写字页主循环每帧调用。静止且已画过就直接返回，不占 CPU。
  step(now) {
    if (!this.ready) return;
    if (!this._anim && !this._dirty) return;

    const K = this._k;
    let shakeX = 0, shakeY = 0, inkAlpha = 1, penLift = 0;
    let nib = { x: NIB.x, y: NIB.y };
    const reveal = [1, 1, 1, 1];

    if (this._anim) {
      const tl = this._anim.tl;
      const t = now - this._anim.t0;
      if (t >= tl.total) {
        if (this._looping) {
          this.poke();          // 接着播下一遍
        } else {
          this._anim = null;
          this._dirty = true;   // 收尾这一帧还得画一次，回到静止态
        }
      } else {
        // 纸抖：阻尼正弦，横向为主
        if (t < tl.shakeDur && this.shakeScale) {
          const damp = Math.pow(1 - t / tl.shakeDur, 2);
          shakeX = Math.sin((t / 1000) * 46) * TUNING.shake * this.shakeScale * damp;
          shakeY = Math.sin((t / 1000) * 38 + 1.1) * TUNING.shake * this.shakeScale * 0.45 * damp;
        }
        inkAlpha = 1 - clamp01((t - tl.fadeAt) / TUNING.fade);
        penLift = clamp01((t - tl.liftAt) / 160);

        if (t >= tl.travelAt && t < tl.writeAt) {
          // 抬着笔飞回第一段的落笔点，走一条小抛物线
          const p = easeInOut(clamp01((t - tl.travelAt) / TUNING.ret));
          nib = {
            x: NIB.x + (STROKES[0].from[0] - NIB.x) * p,
            y: NIB.y + (STROKES[0].from[1] - NIB.y) * p - Math.sin(p * Math.PI) * 90,
          };
        } else if (t >= tl.writeAt) {
          if (!this._firedWriteStart) {
            this._firedWriteStart = true;
            this.onWriteStart?.();
          }
          penLift = 0;
          inkAlpha = 1;
          const wt = t - tl.writeAt;
          reveal.fill(0);
          for (const it of tl.items) {
            if (wt >= it.t1) { if (it.kind === 'draw') reveal[it.i] = 1; continue; }
            if (wt < it.t0) continue;
            const p = (wt - it.t0) / (it.t1 - it.t0);
            if (it.kind === 'draw') {
              reveal[it.i] = p;
              nib = {
                x: it.s.from[0] + (it.s.to[0] - it.s.from[0]) * p,
                y: it.s.from[1] + (it.s.to[1] - it.s.from[1]) * p,
              };
            } else {
              const e = easeInOut(p);
              penLift = Math.sin(p * Math.PI) * 0.55;
              nib = {
                x: it.from[0] + (it.to[0] - it.from[0]) * e,
                y: it.from[1] + (it.to[1] - it.from[1]) * e - Math.sin(p * Math.PI) * 40,
              };
            }
          }
          if (wt >= tl.writeLen) { reveal.fill(1); nib = { x: NIB.x, y: NIB.y }; }
        }
      }
    } else {
      this._dirty = false;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this._side, this._side);
    ctx.save();
    ctx.translate(this._pad, this._pad);   // 之后所有坐标都按素材原坐标算

    // 纸和写在纸上的字一起抖——字是写在这张纸上的，不跟着走就穿帮了
    ctx.save();
    ctx.translate(shakeX * K, shakeY * K);
    ctx.drawImage(this._layer.paper, 0, 0);
    ctx.globalAlpha = inkAlpha;
    for (let i = 0; i < STROKES.length; i++) {
      const r = reveal[i];
      if (r <= 0) continue;
      const s = STROKES[i];
      ctx.save();
      // 先框住这一段自己的范围，免得切口扫到邻段
      ctx.beginPath();
      ctx.rect((s.bbox[0] - 10) * K, (s.bbox[1] - 10) * K,
               (s.bbox[2] - s.bbox[0] + 20) * K, (s.bbox[3] - s.bbox[1] + 20) * K);
      ctx.clip();
      if (r < 1) {
        // 再沿书写方向推进一道斜切口，字就跟着笔尖一点点显出来
        const ang = Math.atan2(s.to[1] - s.from[1], s.to[0] - s.from[0]);
        const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
        ctx.save();
        ctx.translate(s.from[0] * K, s.from[1] * K);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.rect(-60 * K, -400 * K, (len * r + 60) * K, 800 * K);
        ctx.restore();
        ctx.clip();
      }
      ctx.drawImage(this._layer.line, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // 笔：笔尖对准当前书写点。抬笔时整支往上移一点、略微放大，假装离开了纸面。
    // 笔是被握在手里的，只跟着纸抖四分之一——跟纸同步晃的话像粘在纸上。
    ctx.save();
    const scale = 1 + penLift * 0.04;
    ctx.translate((nib.x - NIB.x) * K + shakeX * K * 0.25,
                  (nib.y - NIB.y) * K + shakeY * K * 0.25 - penLift * TUNING.lift * K);
    ctx.translate(NIB.x * K, NIB.y * K);
    ctx.scale(scale, scale);
    ctx.translate(-NIB.x * K, -NIB.y * K);
    ctx.drawImage(this._layer.pen, 0, 0);
    ctx.restore();

    ctx.restore();
  }
}
