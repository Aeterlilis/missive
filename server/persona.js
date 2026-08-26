// 转接头。默认人设文案在 web/src/shared/persona.js，跟手机版共用同一份，见 ./shared.js。
// 取值必须在 start() await 过 load() 之后，所以这里是 getter 而不是直接导出字符串。

const shared = require('./shared');
const mod = () => shared.get('persona');

module.exports = {
  get DEFAULT_PERSONA() { return mod().DEFAULT_PERSONA; },
  get INSTRUCTION() { return mod().INSTRUCTION; },
};
