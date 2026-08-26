// 转接头：把 web/src/shared/ 下那些"后端和手机版共用"的模块引进 CJS 世界。
//
// 那几个文件是 ESM——手机上没有后端，同一份代码要直接在浏览器里跑，所以只能是 ESM。
// Node 这边只能异步加载 ESM，而 server/ 里到处是同步取用，于是：
//   start() 里先 await load() 一次，之后各个转接头照常同步调。
// 忘了 await 就会在第一次用到时炸出"还没加载"，不会静默走错路。

const MODULES = {
  providers: '../web/src/shared/providers.js',
  upstream: '../web/src/shared/upstream.js',
  persona: '../web/src/shared/persona.js',
  settingsModel: '../web/src/shared/settings-model.js',
};

const loaded = {};
let loading = null;

async function load() {
  if (!loading) {
    const names = Object.keys(MODULES);
    loading = Promise.all(names.map((n) => import(MODULES[n]))).then((mods) => {
      names.forEach((n, i) => { loaded[n] = mods[i]; });
    });
  }
  await loading;
  return loaded;
}

function get(name) {
  const mod = loaded[name];
  if (!mod) throw new Error(`共用模块 ${name} 还没加载，start() 里应当先 await load()`);
  return mod;
}

module.exports = { load, get };
