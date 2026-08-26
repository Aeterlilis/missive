// Service Worker —— 装到手机上之后，应用本体存在本地，断网也打得开，打开也不用等下载。
//
// 分两层缓存，因为体积差得太远：
//   外壳（页面/样式/脚本/图标，约 1.4MB）—— 安装时一次全存下来。
//   字体和纸张背景（加起来 55MB，光中文字体就有五个、最大的 25MB）—— 用到哪个存哪个。
//     十个字体是 @font-face 声明的，浏览器本来就只下载真正用到的那个；全预存等于
//     让人在装的时候先等 55MB，在国内的网络下这一步就能把人劝退。
//
// 更新策略：新版本装好之后**不抢**，老老实实等在后面，等应用整个关掉再打开才接手。
// 抢的话正在跑的页面会一半旧一半新——这套代码是 ES 模块，混着加载直接报错。

// ⚠️ 每次发新版都要把这个号往上加，否则装过的机器永远吃老的那份。
// 浏览器是靠"sw.js 这个文件本身变没变"来决定要不要重装的——版本号不动，
// 底下那一堆文件就算全改了，它也不会重新去取。
const VERSION = 'missive-v4';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

// 安装时就要存下来的。路径相对于本文件所在目录，注册在哪个子路径下都成立
// （GitHub Pages 上应用是挂在 /missive/ 这种子路径里的，写死绝对路径会全部落空）。
const SHELL = [
  './',
  'index.html',
  'settings.html',
  'history.html',
  'manifest.json',
  'icon.png',
  'chrome-theme.css',
  'color-picker.css',
  'glass.css',
  'history.css',
  'paper-theme.css',
  'range-slider.css',
  'settings.css',
  'styles.css',
  'lib/perfect-freehand.js',
  'img/icon-line.png',
  'img/icon-paper.png',
  'img/icon-pen.png',
  'src/api-error.js',
  'src/api-local.js',
  'src/api-remote.js',
  'src/api.js',
  'src/app.js',
  'src/appicon.js',
  'src/capture.js',
  'src/config.js',
  'src/dissolve.js',
  'src/glass.js',
  'src/history.js',
  'src/ink.js',
  'src/oracle.js',
  'src/pwa.js',
  'src/pokelines.js',
  'src/scribe.js',
  'src/settings.js',
  'src/store.js',
  'src/shared/conversation.js',
  'src/shared/persona.js',
  'src/shared/providers.js',
  'src/shared/settings-model.js',
  'src/shared/upstream.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个存而不是 addAll：addAll 是一个不成全不成，少一个文件整个安装就失败，
    // 而且不告诉你是哪个。这里哪个没存上就记一笔，剩下的照常。
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (e) {
        console.warn('[sw] 外壳文件没存上:', path, e.message);
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => !n.startsWith(VERSION))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 打给 AI 的请求不碰，让它直接走网络

  // 探"服务在不在"那一下必须真的去问网络：从缓存里应付一个答案，页面就会误判成
  // 有后端可用（见 web/src/api.js）。/api/ 底下一律不接管。
  if (url.pathname.includes('/api/')) return;

  event.respondWith((async () => {
    // ignoreSearch 必须开：页面引脚本是带 ?v=N 的（`src/app.js?v=39`），而上面存的是
    // 不带查询串的路径，不忽略就一个也命中不了，等于白存一场。
    // 那个 ?v=N 管的是浏览器自己的缓存；到了这一层，版本由上面的 VERSION 说了算。
    const shell = await caches.open(SHELL_CACHE);
    const hit = await shell.match(req, { ignoreSearch: true });
    if (hit) return hit;

    // 外壳里没有的同源文件——字体、纸张背景这些。先看存过没有，没有就下，下完存起来。
    const assets = await caches.open(ASSET_CACHE);
    const cached = await assets.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // 只存正经成功的。opaque 响应（跨域且没开 CORS）状态码读出来是 0，
      // 存下来的是个空壳，下次命中就等于拿到一个坏文件。
      if (res && res.ok && res.type === 'basic') {
        assets.put(req, res.clone());
      }
      return res;
    } catch (e) {
      // 断网了。页面本身在外壳里，能打开；这里落空的多半是还没下过的字体，
      // 让它照常失败，浏览器会退回系统字体，比整页打不开强。
      throw e;
    }
  })());
});
