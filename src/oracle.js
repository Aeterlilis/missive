// oracle.js —— 接收后端流式 SSE，按句断句，把"一句完整的回答"推给手写动画
// 移植自 riddle 的 StreamParser / sentence_cut：
//   - 边收 token 边累积
//   - 遇到句末标点（. ! ? 。！？…）+ 后续空白，就把前面那一句吐出来
//   - 流结束时把剩余未结束的尾巴也吐出来
// 这样 scribe.js 可以"边生成边写"，不用等整段回完。

const SENTENCE_END = /[.!?。！？…]+/;

// 用法：
//   const oracle = new OracleStream(stream);
//   for await (const sentence of oracle.sentences()) { scribe.write(sentence); }
export class OracleStream {
  constructor(stream) {
    this.stream = stream; // ReadableStream（来自 fetch 的 res.body）
    this._buf = '';   // 累积的全部文本
    this._pending = ''; // 尚未遇到句末的尾巴
  }

  // 异步迭代器：yield 一个个句子（字符串）
  async *sentences() {
    const reader = this.stream.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    let done = false;

    while (!done) {
      const { done: rdone, value } = await reader.read();
      if (rdone) { done = true; break; }
      sseBuf += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let idx;
      while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
        const block = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        const piece = this._extractToken(block);
        if (piece === DONE) { done = true; break; }
        if (piece) {
          this._buf += piece;
          // 尝试从 pending 里切出完整句
          const { sentences, rest } = cutSentences(this._pending + piece);
          this._pending = rest;
          for (const s of sentences) yield s;
        }
      }
    }
    reader.releaseLock?.();

    // 流结束，把剩下的尾巴作为最后一句吐出
    if (this._pending.trim()) {
      yield this._pending;
      this._pending = '';
    }
  }

  // 整段已收到的文本（调试用）
  fullText() {
    return this._buf;
  }

  // 从一个 SSE 事件块里提取 token 文本
  _extractToken(block) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return DONE;
      try {
        const obj = JSON.parse(data);
        if (typeof obj === 'string') return obj;
        if (obj && typeof obj === 'object') {
          if (typeof obj.content === 'string') return obj.content;
          if (obj.error) throw new Error(obj.error);
        }
      } catch (e) {
        // 非 JSON 的 data 行，忽略
      }
    }
    return null;
  }
}

const DONE = Symbol('done');

// 把一段文本切成"完整句 + 剩余尾巴"
// 规则（移植自 riddle sentence_cut）：
//   找到句末标点，且其后跟空白/换行，则在此处断句；丢弃过短的片段
function cutSentences(text) {
  const sentences = [];
  let rest = text;
  // 反复切，直到没有更多完整句
  for (;;) {
    const m = rest.match(SENTENCE_END);
    if (!m) break;
    const end = m.index + m[0].length;
    // 看后面是否是空白/结尾
    const after = rest.slice(end);
    const wsMatch = after.match(/^\s*/);
    const cut = end + (wsMatch ? wsMatch[0].length : 0);
    const piece = rest.slice(0, cut);
    // 太短的片段（只有标点没有内容）不单独成句，留到下一轮
    if (piece.replace(/\s/g, '').length >= 2) {
      sentences.push(piece);
    }
    rest = rest.slice(cut);
  }
  return { sentences, rest };
}
