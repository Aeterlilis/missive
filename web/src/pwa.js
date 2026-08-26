// 把 Service Worker 挂上去，应用才装得到桌面、断网也打得开。见 ../sw.js。
//
// 这件事只在"安全上下文"里成立：https 或者 localhost。用局域网 IP（http://192.168.…）
// 打开时浏览器根本不给 navigator.serviceWorker，所以下面那个判断不是防御性写法，
// 是真会走到的分支——不给注册就不注册，应用照常能用，只是不能装、每次都要联网加载。
//
// 地址用 import.meta.url 现算：应用可能挂在某个子路径下（GitHub Pages 上是 /missive/），
// 写死 '/sw.js' 会指到站点根目录去，注册必然失败。

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('../sw.js', import.meta.url);
  // 等页面加载完再注册：注册本身会去下载整个外壳，跟首屏抢带宽不值得
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swUrl, { scope: new URL('./', swUrl) })
      .catch((e) => console.warn('Service Worker 没注册上:', e.message));
  });
}
