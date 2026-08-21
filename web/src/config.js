// 全局配置 & 时序常量。
// 大部分移植自 riddle 的 main.rs，全部转成 JS。

export const CONFIG = {
  // ─── 停笔提交 ───────────────────────────────────
  // 多少毫秒没动笔就认为"写完了"，把这一页提交给 AI
  IDLE_COMMIT_MS: 2800,
  // 等 AI 回复的最长时间。中转站 403 频繁，后端要重试多次（指数退避，最坏 1+2+...+8=36s），
  // 给足耐心避免前端提前判定超时。
  ORACLE_PATIENCE_MS: 90000,

  // ─── 饮墨（淡掉用户字迹）────────────────────────
  // 手写不好精确拆成"一笔一笔"（字距不规律），整页一起拍快照做 alpha 渐变，简单稳定
  DRINK_FADE_MS: 900,

  // ─── 思考（呼吸点）──────────────────────────────
  THINK_PULSE_MS: 600,

  // ─── 书写（AI 回答一笔笔浮现）──────────────────
  // 每帧"写"多少个骨架点，多少毫秒一帧
  SCRIBE_POINTS_PER_FRAME: 26,
  SCRIBE_FRAME_MS: 14,
  // 回答正文字号 & 留白：基准值（大屏用），小屏由 layout() 动态缩小
  REPLY_FONT_PX: 96,
  MARGIN_X: 120,

  // ─── 屏幕自适应（核心）──────────────────────────
  // 根据画布宽高，算出合适的字号、留白、回答可用区域。
  // 目标：任何设备上，回答都不超出屏幕底部，字号随屏宽缩放。
  layout(canvasW, canvasH) {
    // 字号 = 屏宽的 1/12，限制在 [40, 96] 之间（小屏不小于40，大屏不超过96）
    const fontPx = Math.max(40, Math.min(96, Math.round(canvasW / 12)));
    // 左右留白 = 屏宽的 8%，限制在 [40, 120]
    const marginX = Math.max(40, Math.min(120, Math.round(canvasW * 0.08)));
    // 行高 = 字号 × 1.4
    const lineHeight = Math.round(fontPx * 1.4);
    // 回答起始 Y：屏幕上 1/6 处（留出顶部空间，但不从正中间开始）
    const startY = Math.round(canvasH / 6);
    // 回答底部边界：留出底部 15% 空间（不写到底）
    const maxY = Math.round(canvasH * 0.85);
    return { fontPx, marginX, lineHeight, startY, maxY };
  },
  // 上传给 AI 的 PNG 长边上限，以及至少降采样倍数
  // 注意：手写识别对清晰度敏感，尺寸太小模型会"看不清"而回"墨迹晕开了"。
  // 不强制降采样（MIN_DOWNSCALE=1），长边上限给足，让模型看清笔画细节。
  PNG_MAX_LONG_SIDE: 1560,
  PNG_MIN_DOWNSCALE: 1,

  // ─── 停留 ───────────────────────────────────────
  // 写完后停留展示多久：基础 + 每字加成，封顶 20s
  LINGER_BASE_MS: 7000,
  LINGER_PER_CHAR_MS: 2,
  LINGER_MAX_MS: 20000,

  // ─── 淡出 AI 回答 ───────────────────────────────
  // 整段回复的透明度随时间线性降到 0（一次性快照做 alpha 渐变），不是逐点擦除，
  // 更像"淡入淡出"而不是"倒放书写"。时长可在设置里调。
  FADE_DURATION_MS: 1500,

  // ─── 字体 ───────────────────────────────────────
  // 纯英文回答用的字体（含中文的一律用 LXGW WenKai）。运行时会被 /api/settings 的 font 覆盖。
  LATIN_FONT: 'Pinyon Script',

  // ─── 笔 ─────────────────────────────────────────
  // 压感低于此值不算在写（移植自 riddle 的 40/4096）
  PEN_PRESSURE_FLOOR: 0.01,
  // 笔迹线条基础半径（画单点时用，正常连笔走 perfect-freehand 的 size）
  INK_RADIUS: 2,
  // 当前笔刷（运行时被 /api/settings 的 brush 覆盖）
  INK_COLOR: '#000000',
  BRUSH_SIZE: 7,
  BRUSH_PRESET_NAME: 'pen',
  BRUSH_PARAMS: { thinning: 0.6, smoothing: 0.5, streamline: 0.5, alpha: 1 }, // preset 决定的手感

  // ─── 自动发送 ─────────────────────────────────────
  // 是否启用"停笔几秒自动发送"；关掉的话只能靠手动点发送按钮。运行时被 /api/settings 覆盖。
  AUTO_SEND_ENABLED: true,

  // 防误触：只认笔，手指/手掌触摸一律忽略。运行时被 /api/settings 覆盖。
  PEN_ONLY: false,

  // ─── 主循环 ─────────────────────────────────────
  LOOP_TICK_MS: 16, // 约 60fps 的逻辑 tick（实际绘制按各自时序）
};

// 笔刷预设：每种笔各带一套默认粗细/手感/透明度，切预设时粗细跟着变，不然感觉不出区别。
// defaultSize 只在切换预设时用来自动填充粗细滑块，用户改了之后就按用户的来。
export const BRUSH_PRESETS = {
  pen: { defaultSize: 6, thinning: 0.5, smoothing: 0.5, streamline: 0.5, alpha: 1 },
  ballpoint: { defaultSize: 4, thinning: 0.15, smoothing: 0.3, streamline: 0.4, alpha: 1 },
  // 马克笔：明显更粗 + 半透明，笔画交叠的地方会自然叠深，跟真马克笔一样
  marker: { defaultSize: 18, thinning: 0.05, smoothing: 0.6, streamline: 0.6, alpha: 0.55 },
  brush: { defaultSize: 10, thinning: 0.85, smoothing: 0.6, streamline: 0.35, alpha: 1 },
  // 尖笔：蘸水笔那种会张开的簧片尖，粗细完全看下笔力度——主干笔画故意压重写粗，
  // 牵丝花饰故意提轻写细，铜版体/圆体英文花体字就靠这个粗细反差认字。
  // thinning 拉到接近满，压感差异会被放大成很夸张的粗细对比。
  pointed: { defaultSize: 16, thinning: 0.8, smoothing: 0.5, streamline: 0.6, alpha: 1 },
  // 平笔：扁头笔尖，粗细跟压感/速度无关，只看笔画方向跟笔尖固定角度的夹角——
  // 顺着笔尖方向写就粗，垂直方向写就细，这就是书法笔那种粗细变化的来源。
  // 走的是完全不同的渲染路径（见 ink.js 的 chisel 分支），不用 perfect-freehand 那套。
  flat: { defaultSize: 16, chisel: true, nibAngleDeg: 45, alpha: 1 },
};

// 颜色：墨水屏只认纯黑白，不要灰度（残影重）
export const COLOR = {
  PAPER: '#ffffff',
  INK: '#000000',
};
