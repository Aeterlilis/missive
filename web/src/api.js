// api.js —— 所有"数据从哪来、往哪存、AI 请求谁来发"的事都走这里，页面不再自己 fetch。
//
// 为什么要有这一层：现在这一版是"网页 + 本机 Node 服务"，设置、历史记录都存在服务
// 那边的磁盘上，AI 请求也是服务替页面转发的。搬到手机上之后没有服务这回事，同样这些
// 事得全在浏览器里干——设置和历史存 IndexedDB，AI 请求从页面直接发。
// 两种活法的差别全关在这个文件里，三个页面看到的是同一组方法。
//
// 现在只实现了 remote（走 Node 服务）这一套，行为跟改造前逐字一致。
// local 那一套（IndexedDB + 直连 AI）跟在后面做，做好之后开机探一次服务在不在，
// 探得到走 remote，探不到走 local。
//
// 约定：
//   - 请求失败一律抛 ApiError，`message` 是服务给的那句人话，`status` 是状态码。
//     调用方原本那套 `out.error || '创建失败'` 的兜底不用再写，catch 到直接用 message。
//   - 返回值就是原来接口回的 JSON，形状没动。
//   - 拿图片/字体这类"要塞进 CSS 或 FontFace 的地址"，方法名以 Url 结尾且返回 Promise
//     ——本地模式下那是从 IndexedDB 现取出来的 blob: 地址，天生是异步的。

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// 把一次 fetch 收成 { 成功→JSON, 失败→抛 ApiError }。
// 服务给的报错体是 { error, detail }；拿不到（比如 500 直接吐了 HTML）就退回带状态码的通用说法。
async function callJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
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

const remote = {
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

export const api = remote;
