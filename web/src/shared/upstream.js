// 往上游模型服务发请求、把回来的流拆成纯文本。后端和手机版共用同一份。
//
// 请求发什么形状、流回来怎么拆，各家规范的差别全在 ./providers.js；这个文件只管
// "发出去、重试、一段段读回来"这三件事，不关心对面是谁。
//
// 只用标准 JS 和 fetch，不许碰 fs/Buffer/process——手机上这份是在浏览器里跑的。

import { DONE, buildRequest, parseDelta } from './providers.js';

// 这几个状态码是"再试一次说不定就过了"：中转站对图片请求会高频 403，
// 429/500 也常常是一阵子的事。别的错（401 密钥不对、404 模型不存在）重试没意义。
const RETRY_STATUS = new Set([403, 429, 500]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function upstreamError(message, status, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

// 往上游发一次请求，带退避重试。成功返回 fetch 的 Response，失败抛出带 status/detail 的错误。
// onRetry 是可选的旁观者，只用来打日志——后端要往控制台写，浏览器里不写。
export async function postUpstream(profile, request, { maxRetries = 8, onRetry } = {}) {
  const { url, headers, body } = buildRequest(profile, request);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let upstream;
    try {
      upstream = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      onRetry?.(`第${attempt}次连接失败: ${err.message}`);
      if (attempt === maxRetries) throw upstreamError('无法连接模型服务', 502, err.message);
      await sleep(300 * attempt);
      continue;
    }
    if (upstream.ok && (!request.stream || upstream.body)) return upstream;

    const detail = await upstream.text().catch(() => '');
    if (RETRY_STATUS.has(upstream.status) && attempt < maxRetries) {
      onRetry?.(`第${attempt}次上游 ${upstream.status}，${attempt}s 后重试`);
      await sleep(1000 * attempt);
      continue;
    }
    onRetry?.(`上游 ${upstream.status}: ${detail.slice(0, 300)}`);
    throw upstreamError('模型服务返回错误', upstream.status, detail);
  }
  throw upstreamError('多次重试后仍无法获取模型响应', 502);
}

// 把上游的流按当前规范拆成纯文本增量，一段段吐出来。
// 上游发了结束事件就停；Gemini 不发，流断了就是完了。
export async function* readTokens(response, profile) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) !== -1) { // SSE 事件以空行分隔
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const piece = parseDelta(profile, block);
        if (piece === DONE) return;
        if (piece) yield piece;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

// 一次性把整段读完（不需要边收边显示的场合用，比如让 AI 总结成长期记忆）
export async function readAllText(response, profile) {
  let full = '';
  for await (const piece of readTokens(response, profile)) full += piece;
  return full;
}
