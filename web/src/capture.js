// capture.js —— 把当前笔迹裁剪+降采样成 PNG，POST 给后端 /interpret
// 逻辑移植自 riddle 的 Ink::to_png：
//   - 取所有笔画的包围盒，外扩 padding
//   - 长边降采样到 ≤ PNG_MAX_LONG_SIDE，且至少降 PNG_MIN_DOWNSCALE 倍
//   - 取灰度（墨水屏本就是黑白，绿通道近似亮度）
//   - 导出为 PNG

import { CONFIG } from './config.js';

// 从主画布裁出笔迹区域并降采样，返回 PNG Blob
// strokes: [{x,y}] 的数组（来自 InkLayer.strokes，可能是当前笔画 + 已完成笔画）
export function strokesToPngBlob(strokes, sourceCanvas) {
  const bbox = boundingBox(strokes);
  if (!bbox) throw new Error('没有墨迹，无法截图');

  const pad = 20;
  const x0 = Math.max(0, bbox.minX - pad);
  const y0 = Math.max(0, bbox.minY - pad);
  const x1 = Math.min(sourceCanvas.width, bbox.maxX + pad);
  const y1 = Math.min(sourceCanvas.height, bbox.maxY + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error('裁剪区域为空');

  const longSide = Math.max(w, h);
  // 至少降采样 PNG_MIN_DOWNSCALE 倍，且保证长边 ≤ PNG_MAX_LONG_SIDE
  const factor = Math.max(
    CONFIG.PNG_MIN_DOWNSCALE,
    Math.ceil(longSide / CONFIG.PNG_MAX_LONG_SIDE)
  );
  const outW = Math.max(1, Math.floor(w / factor));
  const outH = Math.max(1, Math.floor(h / factor));

  // 用 OffscreenCanvas（支持时）或临时 canvas 做降采样
  let out;
  if (typeof OffscreenCanvas !== 'undefined') {
    out = new OffscreenCanvas(outW, outH);
  } else {
    out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
  }
  const octx = out.getContext('2d', { willReadFrequently: false });
  // 关闭平滑：墨水屏要干脆的黑白边缘，不要抗锯齿灰边（残影重）
  octx.imageSmoothingEnabled = false;
  // 先把原画布的对应区域画过来
  octx.drawImage(sourceCanvas, x0, y0, w, h, 0, 0, outW, outH);

  return { canvas: out, x0, y0, w, h, outW, outH };
}

// 把降采样后的 canvas 转成 Blob（PNG）
export function canvasToBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png');
  });
}

// 服务返回的报错是 JSON（{error, detail}）。整串塞进 Error.message 的话，弹给用户看
// 就是一堆花括号；这里把 error 那句话取出来，取不到再退回原文。
// 末尾带上状态码：给人排查用，"还没配置 API（400）" 比光一句话更好定位。
function explainHttpError(status, body) {
  let msg = '';
  try { msg = (JSON.parse(body) || {}).error || ''; } catch { /* 不是 JSON 就按原文处理 */ }
  if (!msg) msg = String(body || '').trim().slice(0, 120);
  return (msg || '没有说明原因') + `（${status}）`;
}

// fetch 自己抛出来的错 message 是 "Failed to fetch" 这类，对着用户显示等于没说。
//
// 措辞刻意不提"后端"：那是这一版的实现细节，而且"后端没跑"这个情况根本轮不到这里报——
// 页面本身就是它发的，它没跑的话浏览器连页面都打不开。真正会走到这儿的是：
//   · 页面开着的时候服务中途挂了（比如被 Ctrl+C 了）
//   · 手机/平板通过局域网访问，WiFi 断了
//   · 将来去服务器化之后，前端直接调 AI 接口——断网或被 CORS 挡住都长这样
// 三种都是"这次请求没发出去"，跟有没有后端无关，所以只说这一层。
function explainThrown(e) {
  if (e instanceof TypeError) return '请求没能发出去，检查一下网络连接';
  return e && e.message ? e.message : '未知错误';
}

// 把笔迹 PNG POST 到后端，返回一个流式 reader（见 oracle.js 消费）
// 带重试：中转站偶发 403/超时，后端会重试，前端也重试以匹配。
// 但配置类错误（4xx）不重试——密钥填错了，重试三次还是错，白等两秒。
export async function postInterpret(blob) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastErr = new Error(explainHttpError(res.status, detail));
        // 403/500/502 可能是中转站瞬抖，值得重试；4xx 是配置问题，重试多少次都一样
        lastErr.retryable = res.status === 403 || res.status >= 500;
        if (lastErr.retryable && attempt < 3) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        throw lastErr;
      }
      if (!res.body) throw new Error('没有收到回答的内容');
      return res.body;
    } catch (e) {
      lastErr = e;
      if (e.retryable === false) throw e;   // 配置错了，重试多少次都一样
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      // 带 retryable 的是上面按状态码造的，已经是人话了；没有这个标记的是 fetch
      // 自己抛的（"Failed to fetch"），得翻一道再往上抛
      throw e.retryable === undefined ? new Error(explainThrown(e)) : e;
    }
  }
  throw lastErr || new Error('多次重试后仍失败');
}

// 打字模式：把文字 POST 到 /interpret-text（JSON body），返回值和 postInterpret 一样是流式 reader
export async function postInterpretText(text) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('/interpret-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastErr = new Error(explainHttpError(res.status, detail));
        // 403/500/502 可能是中转站瞬抖，值得重试；4xx 是配置问题，重试多少次都一样
        lastErr.retryable = res.status === 403 || res.status >= 500;
        if (lastErr.retryable && attempt < 3) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        throw lastErr;
      }
      if (!res.body) throw new Error('没有收到回答的内容');
      return res.body;
    } catch (e) {
      lastErr = e;
      if (e.retryable === false) throw e;   // 配置错了，重试多少次都一样
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      // 带 retryable 的是上面按状态码造的，已经是人话了；没有这个标记的是 fetch
      // 自己抛的（"Failed to fetch"），得翻一道再往上抛
      throw e.retryable === undefined ? new Error(explainThrown(e)) : e;
    }
  }
  throw lastErr || new Error('多次重试后仍失败');
}

// 取所有笔画的轴对齐包围盒
function boundingBox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const stroke of strokes) {
    for (const p of stroke) {
      any = true;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}
