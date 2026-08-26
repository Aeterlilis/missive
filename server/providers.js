// 转接头。真正的实现在 web/src/shared/providers.js，跟手机版共用同一份，见 ./shared.js。
// 下面这层包装只为让 index.js 里的调用照旧写成 providers.xxx()。

const shared = require('./shared');
const mod = () => shared.get('providers');

module.exports = {
  // DONE 是个 Symbol，靠身份比较（index.js 里 `result === providers.DONE`）。
  // 动态 import 有缓存，全进程只有一份实例，所以每次取到的都是同一个。
  get DONE() { return mod().DONE; },
  get SPECS() { return mod().SPECS; },
  get SPEC_IDS() { return mod().SPEC_IDS; },
  detectSpec: (...a) => mod().detectSpec(...a),
  resolveSpec: (...a) => mod().resolveSpec(...a),
  buildRequest: (...a) => mod().buildRequest(...a),
  parseDelta: (...a) => mod().parseDelta(...a),
  extractText: (...a) => mod().extractText(...a),
  listModels: (...a) => mod().listModels(...a),
};
