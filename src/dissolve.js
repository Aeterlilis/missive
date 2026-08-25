// dissolve.js —— 哈希溶解淡出："纸把墨吸走"
// 移植自 riddle 的 ink::dissolve_pass + px_hash：
//   每个墨迹像素有一个固定的伪随机哈希值；第 k 轮溶解时，
//   hash(x,y) % STAGES <= k 的像素被擦成透明。STAGES 轮后区域全透明。
//   比线性 alpha 渐变更适合墨水屏：始终是纯黑或透明，没有灰度残影。
//
// 画布本身是透明的（背景色/纹理是 CSS 画在 canvas 下面的），所以这里认"墨迹"
// 靠 alpha 通道而不是亮度——不管背景是白纸、牛皮纸还是米黄色，判断逻辑都一样，
// "擦掉"也统一变成 alpha=0，露出底下的背景，而不是画死一块白色盖上去。

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
      // 只处理有墨迹的像素（alpha>0），画布背景本身是全透明的
      if (d[i + 3] > 0) {
        // 绝对坐标参与哈希，保证每轮判定稳定
        const h4 = pxHash(x + px, y + py);
        if (h4 % stages <= stage) {
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; // 擦成透明，露出底下的纸
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

// 把一块区域整块擦透明（用于饮墨完成后的兜底清理、或回答淡出后整页清屏）
export function clearRegion(ctx, bbox) {
  ctx.clearRect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
}
