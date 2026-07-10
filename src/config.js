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
  // 哈希溶解分段数 × 间隔 ≈ 总时长。调慢一点，让墨迹从容淡去
  DRINK_STAGES: 14,
  DRINK_INTERVAL_MS: 220,

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
  FADE_STAGES: 10,
  FADE_INTERVAL_MS: 80,

  // ─── 笔 ─────────────────────────────────────────
  // 压感低于此值不算在写（移植自 riddle 的 40/4096）
  PEN_PRESSURE_FLOOR: 0.01,
  // 笔迹线条基础半径
  INK_RADIUS: 2,

  // ─── 主循环 ─────────────────────────────────────
  LOOP_TICK_MS: 16, // 约 60fps 的逻辑 tick（实际绘制按各自时序）
};

// 颜色：墨水屏只认纯黑白，不要灰度（残影重）
export const COLOR = {
  PAPER: '#ffffff',
  INK: '#000000',
};
