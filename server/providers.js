// 转接头。真正的实现在 web/src/shared/providers.js——那是 ESM，手机版（没有后端，
// 得在浏览器里自己调 AI）用的是同一份，所以不能有两份各自演化。
//
// Node 这边只能异步加载 ESM，而 index.js 里到处是同步取用，所以：
//   启动时先 await load() 一次，之后下面这些包装照常同步调。
// 忘了 await 就会在第一次用到时炸出"还没加载"，不会静默走错路。

let impl = null;

function need() {
  if (!impl) throw new Error('providers 还没加载，start() 里应当先 await load()');
  return impl;
}

module.exports = {
  load: async () => {
    if (!impl) impl = await import('../web/src/shared/providers.js');
    return impl;
  },
  // DONE 是个 Symbol，靠身份比较（index.js 里 `result === DONE`）。
  // 动态 import 有缓存，全进程只有一份实例，所以这样取到的永远是同一个。
  get DONE() { return need().DONE; },
  get SPECS() { return need().SPECS; },
  get SPEC_IDS() { return need().SPEC_IDS; },
  detectSpec: (...a) => need().detectSpec(...a),
  resolveSpec: (...a) => need().resolveSpec(...a),
  buildRequest: (...a) => need().buildRequest(...a),
  parseDelta: (...a) => need().parseDelta(...a),
  extractText: (...a) => need().extractText(...a),
  listModels: (...a) => need().listModels(...a),
};
