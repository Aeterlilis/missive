// 请求失败时统一抛这个。message 是给用户看的那句人话，status 是状态码（本地模式下
// 没有真的 HTTP 往返，但页面上不少地方按状态码分支，所以照着同一套编号给）。
// 单独一个文件是为了让 api.js 和两套实现都能引它，不至于互相 import 成环。

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}
