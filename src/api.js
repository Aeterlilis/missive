// api.js —— 所有"数据从哪来、往哪存、AI 请求谁来发"的事都走这里，页面不再自己 fetch。
//
// 两套实现，开机自己判断走哪套：
//   ./api-remote.js —— 打给本机那台 Node 服务。现在的桌面版就是这样。
//   ./api-local.js  —— 全在浏览器里干：设置和历史存 IndexedDB，AI 请求从页面直接发。
//                      手机版走这套。
// 判断办法是探一下服务在不在。探得到走 remote，探不到走 local——手机上打开的是一堆
// 静态文件，那一探必然落空，自然就是本地模式。
//
// 调试时想强制走某一套，地址后面加 ?storage=local 或 ?storage=remote。
//
// 约定：
//   - 请求失败一律抛 ApiError，message 是给用户看的那句人话，status 是状态码。
//     调用方 catch 到直接用 message，不用再写 `out.error || '创建失败'` 那种兜底。
//   - 返回值形状两套完全一致，页面不需要知道自己在跟谁说话。
//   - 拿图片/字体这类"要塞进 CSS 或 FontFace 的地址"，方法名以 Url 结尾且返回 Promise
//     ——本地模式下那是从 IndexedDB 现取出来的 blob: 地址，天生是异步的。
//     没存过就返回空串，不抛错。
//
// 方法一览（两套都实现了同样这些）：
//   getSettings / saveSettings / resetContext
//   backgroundImageUrl / saveBackground
//   cjkFontUrl / saveCjkFont / deleteCjkFont
//   listHistory / deleteHistoryEntry
//   createCard / updateCard / deleteCard
//   createProfile / updateProfile / deleteProfile / listModels
//   generatePokeLines
//   interpretInk / interpretText —— 返回 Response，流式，归 capture.js 消费

import { ApiError } from './api-error.js';
import { remote } from './api-remote.js';
import { local } from './api-local.js';

export { ApiError };

// 探服务在不在。超时掐短一点：探不到是常态（手机上就没有服务），不该让页面白等。
async function serverAlive() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    // 相对当前页面算，不写死 '/api/health'：应用可能挂在子路径下（GitHub Pages 上是
    // /missive/），写死会跑去站点根目录问，问的不是自己那台。
    const probe = new URL('api/health', location.href);
    const res = await fetch(probe, { cache: 'no-store', signal: ac.signal });
    if (!res.ok) return false;
    // 光看 200 不够：静态托管（比如 GitHub Pages）会拿首页去应付任何找不到的路径，
    // 那也是 200，内容却是一整张 HTML。得让服务自报家门才算数。
    const data = await res.json().catch(() => null);
    return !!(data && data.missive === true);
  } catch {
    return false; // 超时、404、断网、跨域，都算没有
  } finally {
    clearTimeout(timer);
  }
}

function forcedMode() {
  try {
    const want = new URLSearchParams(location.search).get('storage');
    return want === 'local' || want === 'remote' ? want : null;
  } catch {
    return null;
  }
}

// 这里刻意**不**用顶层 await。用了的话本模块的求值会拖到探测回来之后，连带
// import 它的 app.js 也一起延后——而 app.js 是在模块求值时挂 DOMContentLoaded 的，
// 一旦晚于那个事件，监听器就再也不会被调用，整个写字页是死的。踩过一次。
//
// 改成"先把 api 交出去，第一次真正调用时才等模式定下来"。反正所有方法本来就是异步的，
// 调用方一个字都不用改。
export const apiReady = (async () => {
  const mode = forcedMode() || ((await serverAlive()) ? 'remote' : 'local');
  window.__apiMode = mode; // 排查问题时在控制台敲 __apiMode 就知道当前是哪套
  return mode === 'local' ? local : remote;
})();

export const api = new Proxy({}, {
  get: (_t, name) => (...args) => apiReady.then((impl) => impl[name](...args)),
});
