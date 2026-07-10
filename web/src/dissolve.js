// dissolve.js —— 哈希溶解淡出："纸把墨吸走"
// 移植自 riddle 的 ink::dissolve_pass + px_hash：
//   每个墨迹像素有一个固定的伪随机哈希值；第 k 轮溶解时，
//   hash(x,y) % STAGES <= k 的像素被擦白。STAGES 轮后区域全白。
//   比线性 alpha 渐变更适合墨水屏：始终是纯黑白，没有灰度残影。

import { CONFIG } from './config.js';

// 对一块区域执行第 stage 轮（从 0 开始）溶解。
// 把该区域里"该消失的墨迹像素"擦白，其余保留。返回这一轮是否还有墨迹。
//
// 实现：直接读 ImageData，逐像素判断。
export function dissolvePass(ctx, bbox, stage, stages = CONFIG.DRINK_STAGES) {
  const { minX: x, minY: y, maxX: x1, maxY: y1 } = bbox;
  const w = x1 - x, h = y1 - y;
  if (w <= 0 || h <= 0) return false;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  let inkLeft = false;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      // 只处理偏暗（墨迹）像素
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < 250) {
        // 绝对坐标参与哈希，保证每轮判定稳定
        const h4 = pxHash(x + px, y + py);
        if (h4 % stages <= stage) {
          d[i] = d[i + 1] = d[i + 2] = 255;
        } else {
          inkLeft = true;
        }
      }
    }
  }
  ctx.putImageData(img, x, y);
  return inkLeft;
}

// 确定性逐像素哈希（移植自 riddle 的 px_hash）
function pxHash(x, y) {
  let h = (Math.imul(x, 0x9e3779b1)) ^ (Math.imul(y >>> 0, 0x85ebca6b));
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// 把一块区域整块擦白（用于饮墨完成后的兜底清理、或回答淡出后整页清屏）
export function clearRegion(ctx, bbox) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
}
