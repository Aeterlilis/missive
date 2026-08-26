// 走本机/局域网那台 Node 服务的实现。桌面版现在用的就是这套。
// 方法清单和约定见 ./api.js。

import { ApiError } from './api-error.js';

// 把一次 fetch 收成 { 成功→JSON, 失败→抛 ApiError }。
// 服务给的报错体是 { error, detail }；拿不到（比如 500 直接吐了 HTML）就退回带状态码的通用说法。
async function callJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    // fetch 自己抛出来的（断网、服务中途挂了、跨域被挡）。措辞见 capture.js 里的说明。
    throw new ApiError('请求没能发出去，检查一下网络连接', 0);
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 不是 JSON，留 null */ }
  if (!res.ok) {
    const msg = (body && body.error) || `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status, body && body.detail);
  }
  return body;
}

const postJson = (url, payload) => callJson(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload || {}),
});

const putJson = (url, payload) => callJson(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload || {}),
});

const del = (url) => callJson(url, { method: 'DELETE' });

// 静态资源加时间戳是为了绕开浏览器缓存：换了背景图/字体之后地址不变，不加就还是旧的。
const bust = () => Date.now();

export const remote = {
  getSettings: () => callJson('/api/settings'),
  saveSettings: (patch) => postJson('/api/settings', patch),
  resetContext: ({ summarize } = {}) => postJson('/api/context/reset', { summarize: !!summarize }),

  backgroundImageUrl: async () => `/api/background-image?t=${bust()}`,
  saveBackground: (imageDataUrl) => postJson('/api/background', { imageDataUrl }),

  cjkFontUrl: async () => `/api/cjk-font-file?t=${bust()}`,
  saveCjkFont: ({ filename, fontDataBase64 }) => postJson('/api/cjk-font', { filename, fontDataBase64 }),
  deleteCjkFont: () => del('/api/cjk-font'),

  listHistory: () => callJson('/api/history'),
  deleteHistoryEntry: (id) => del('/api/history/' + id),

  createCard: (body) => postJson('/api/cards', body),
  updateCard: (id, patch) => putJson('/api/cards/' + id, patch),
  deleteCard: (id) => del('/api/cards/' + id),

  createProfile: (body) => postJson('/api/profiles', body),
  updateProfile: (id, patch) => putJson('/api/profiles/' + id, patch),
  deleteProfile: (id) => del('/api/profiles/' + id),
  listModels: (body) => postJson('/api/models', body),

  generatePokeLines: () => postJson('/api/poke-lines/generate'),

  // 这两个不走 callJson：要的是还没读完的流本身，不是解析好的 JSON。
  // 返回 fetch 的 Response，重试和报错措辞归调用方（capture.js）管——它对
  // "哪些状态码值得再试一次"有自己的判断，那套逻辑跟数据存在哪没关系。
  interpretInk: (pngBlob) => fetch('/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: pngBlob,
  }),
  interpretText: (text) => fetch('/interpret-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }),
};
