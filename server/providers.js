// 上游接口适配层。
//
// 应用内部只认一种中立的请求形状（下面叫“中立请求”），四种上游规范各自把它翻译成
// 自家的 body / URL / 请求头，回来的流也各自拆成纯文本增量。往上加第五种规范，
// 只需要在 SPECS 里多写一条，index.js 不用动。
//
// 中立请求：
//   {
//     model, maxTokens, stream,
//     instructions,                       // 系统提示词，拼好的一整段
//     turns: [{ role: 'user'|'assistant',
//               parts: [{ type: 'text', text } | { type: 'image', dataUrl }] }]
//   }

const DONE = Symbol('done');

// ─── 小工具 ──────────────────────────────────────
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

// data:image/png;base64,xxxx → { mediaType, data }
function splitDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(dataUrl || ''));
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: 'image/png', data: '' };
}

// 从一个 SSE 事件块里把 event: 名字和 data: 内容摘出来。
// data 允许跨多行，按 SSE 规范用换行拼回去。
function readSseBlock(block) {
  let event = '';
  const dataLines = [];
  for (const line of String(block).split('\n')) {
    const t = line.trim();
    if (t.startsWith('event:')) event = t.slice(6).trim();
    else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── OpenAI Responses（/responses）─────────────────
// missive 原本唯一支持的那套。请求头里那两个 codex 标记是给 Codex 专用中转站看的，
// 别的规范不带。
const responsesSpec = {
  label: 'OpenAI Responses',
  placeholder: 'https://xxx.com/v1',
  endpoint: (p) => `${trimSlash(p.baseUrl)}/responses`,
  headers: (p) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`,
    'User-Agent': 'codex_cli_rs/0.45.0',
    originator: 'codex_cli_rs',
  }),
  body: (ir) => ({
    model: ir.model,
    stream: !!ir.stream,
    max_output_tokens: ir.maxTokens,
    ...(ir.instructions ? { instructions: ir.instructions } : {}),
    input: ir.turns.map((t) => ({
      role: t.role,
      content: t.parts.map((part) => (part.type === 'image'
        ? { type: 'input_image', image_url: part.dataUrl }
        : { type: t.role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' })),
    })),
  }),
  delta: (block) => {
    const { event, data } = readSseBlock(block);
    if (event === 'response.completed' || event === 'response.failed' || data === '[DONE]') return DONE;
    if (event === 'response.output_text.delta' && data) {
      const obj = parseJson(data);
      if (obj && typeof obj.delta === 'string') return obj.delta;
    }
    return null;
  },
  text: (data) => {
    if (!data) return '';
    if (typeof data.output_text === 'string') return data.output_text;
    const chunks = [];
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (typeof c.text === 'string') chunks.push(c.text);
      }
    }
    return chunks.join('');
  },
  modelsUrl: (p) => `${trimSlash(p.baseUrl)}/models`,
};

// ─── OpenAI Chat Completions（/chat/completions）───
// 覆盖面最广的一套：DeepSeek、硅基流动、OpenRouter、智谱、Kimi、本地 Ollama/LM Studio，
// 以及大部分中转站都是这个形状。
const chatSpec = {
  label: 'OpenAI Chat Completions',
  placeholder: 'https://api.deepseek.com/v1',
  endpoint: (p) => `${trimSlash(p.baseUrl)}/chat/completions`,
  headers: (p) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`,
  }),
  body: (ir) => {
    const messages = [];
    if (ir.instructions) messages.push({ role: 'system', content: ir.instructions });
    for (const t of ir.turns) {
      // 纯文字的一轮压成字符串再发：不少小厂和本地推理只认字符串形式的 content，
      // 数组形式只在真的带图时才用。
      const allText = t.parts.every((part) => part.type === 'text');
      const content = allText
        ? t.parts.map((part) => part.text || '').join('\n')
        : t.parts.map((part) => (part.type === 'image'
          ? { type: 'image_url', image_url: { url: part.dataUrl } }
          : { type: 'text', text: part.text || '' }));
      messages.push({ role: t.role, content });
    }
    return { model: ir.model, stream: !!ir.stream, max_tokens: ir.maxTokens, messages };
  },
  delta: (block) => {
    const { data } = readSseBlock(block);
    if (!data) return null;
    if (data === '[DONE]') return DONE;
    const obj = parseJson(data);
    const d = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
    // delta.reasoning_content 是思考过程，不往纸上写
    if (d && typeof d.content === 'string' && d.content) return d.content;
    return null;
  },
  text: (data) => (data && data.choices && data.choices[0] && data.choices[0].message
    && typeof data.choices[0].message.content === 'string' ? data.choices[0].message.content : ''),
  modelsUrl: (p) => `${trimSlash(p.baseUrl)}/models`,
};

// ─── Anthropic Messages（/v1/messages）─────────────
// 认证走 x-api-key 而不是 Bearer，图片走 base64 source 而不是 data URL，
// max_tokens 是必填项。
function anthropicBase(baseUrl) {
  let b = trimSlash(baseUrl);
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b;
}

const anthropicSpec = {
  label: 'Anthropic Messages',
  placeholder: 'https://api.anthropic.com',
  endpoint: (p) => `${anthropicBase(p.baseUrl)}/messages`,
  headers: (p) => ({
    'Content-Type': 'application/json',
    'x-api-key': p.apiKey,
    'anthropic-version': '2023-06-01',
  }),
  body: (ir) => ({
    model: ir.model,
    stream: !!ir.stream,
    max_tokens: ir.maxTokens,
    ...(ir.instructions ? { system: ir.instructions } : {}),
    messages: ir.turns.map((t) => ({
      role: t.role,
      content: t.parts.map((part) => {
        if (part.type !== 'image') return { type: 'text', text: part.text || '' };
        const { mediaType, data } = splitDataUrl(part.dataUrl);
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      }),
    })),
  }),
  delta: (block) => {
    const { event, data } = readSseBlock(block);
    if (event === 'message_stop' || event === 'error') return DONE;
    if (event === 'content_block_delta' && data) {
      const obj = parseJson(data);
      // thinking_delta 是思考过程，只收 text_delta
      if (obj && obj.delta && obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
        return obj.delta.text;
      }
    }
    return null;
  },
  text: (data) => (data && Array.isArray(data.content)
    ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('')
    : ''),
  modelsUrl: (p) => `${anthropicBase(p.baseUrl)}/models`,
  modelsHeaders: (p) => ({ 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }),
};

// ─── Google Gemini（generateContent）───────────────
// 模型名写在 URL 里而不是 body 里，流式要额外带 ?alt=sse 才是标准 SSE，
// assistant 那一方叫 model，图片字段叫 inline_data。
function geminiBase(baseUrl) {
  let b = trimSlash(baseUrl);
  if (!b) return 'https://generativelanguage.googleapis.com/v1beta';
  b = b.replace(/\/models$/, '');
  if (!/\/v\d+(beta|alpha)?$/.test(b)) b += '/v1beta';
  return b;
}

const geminiSpec = {
  label: 'Google Gemini',
  placeholder: 'https://generativelanguage.googleapis.com/v1beta',
  endpoint: (p, ir) => {
    const method = ir && ir.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${geminiBase(p.baseUrl)}/models/${encodeURIComponent(ir.model || p.model)}:${method}`;
  },
  headers: (p) => ({
    'Content-Type': 'application/json',
    'x-goog-api-key': p.apiKey,
  }),
  body: (ir) => ({
    ...(ir.instructions ? { systemInstruction: { parts: [{ text: ir.instructions }] } } : {}),
    contents: ir.turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: t.parts.map((part) => {
        if (part.type !== 'image') return { text: part.text || '' };
        const { mediaType, data } = splitDataUrl(part.dataUrl);
        return { inline_data: { mime_type: mediaType, data } };
      }),
    })),
    generationConfig: { maxOutputTokens: ir.maxTokens },
  }),
  delta: (block) => {
    const { data } = readSseBlock(block);
    if (!data) return null;
    if (data === '[DONE]') return DONE;
    const obj = parseJson(data);
    const parts = obj && obj.candidates && obj.candidates[0]
      && obj.candidates[0].content && obj.candidates[0].content.parts;
    if (!Array.isArray(parts)) return null;
    // thought:true 的 part 是思考过程，不往纸上写
    const text = parts.filter((x) => x && !x.thought && typeof x.text === 'string')
      .map((x) => x.text).join('');
    return text || null;
  },
  text: (data) => {
    const parts = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.filter((x) => x && !x.thought && typeof x.text === 'string').map((x) => x.text).join('');
  },
  modelsUrl: (p) => `${geminiBase(p.baseUrl)}/models`,
  modelsHeaders: (p) => ({ 'x-goog-api-key': p.apiKey }),
  // Gemini 的模型列表形状是 { models: [{ name: "models/gemini-2.5-flash" }] }
  modelsPick: (data) => (Array.isArray(data && data.models) ? data.models : [])
    .map((m) => String((m && m.name) || '').replace(/^models\//, ''))
    .filter(Boolean),
};

const SPECS = {
  responses: responsesSpec,
  chat: chatSpec,
  anthropic: anthropicSpec,
  gemini: geminiSpec,
};

const SPEC_IDS = Object.keys(SPECS);

// 从 baseUrl 猜规范。猜不准的一律当 Chat Completions——市面上这个形状最多，
// 而且设置页里能手动改回来。
function detectSpec(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (/anthropic|\/claude/.test(u)) return 'anthropic';
  if (/generativelanguage|googleapis|gemini/.test(u)) return 'gemini';
  if (/codex|\/responses/.test(u)) return 'responses';
  return 'chat';
}

// 配置槽位上存的是 'auto' 或某个具体规范；auto 就现场按 URL 猜
function resolveSpec(profile) {
  const want = (profile && profile.spec) || 'auto';
  if (want !== 'auto' && SPECS[want]) return want;
  return detectSpec(profile && profile.baseUrl);
}

function specOf(profile) {
  return SPECS[resolveSpec(profile)];
}

// 中立请求 → { url, headers, body }，body 已经是 JSON 字符串
function buildRequest(profile, ir) {
  const spec = specOf(profile);
  const full = { ...ir, model: ir.model || profile.model };
  return {
    url: spec.endpoint(profile, full),
    headers: spec.headers(profile),
    body: JSON.stringify(spec.body(full)),
  };
}

function parseDelta(profile, eventBlock) {
  return specOf(profile).delta(eventBlock);
}

function extractText(profile, data) {
  if (!data) return '';
  const own = specOf(profile).text(data);
  if (own) return own;
  // 中转站实现五花八门，主口径没抠出来就把别家的形状挨个试一遍，
  // 别为了一个彩蛋去挑供应商。
  for (const id of SPEC_IDS) {
    const t = SPECS[id].text(data);
    if (t) return t;
  }
  return '';
}

// 拉模型列表。各家的路径、认证、返回形状都不同，交给各自的规范说了算。
async function listModels(profile) {
  const spec = specOf(profile);
  const headers = spec.modelsHeaders
    ? spec.modelsHeaders(profile)
    : { Authorization: `Bearer ${profile.apiKey}` };
  const r = await fetch(spec.modelsUrl(profile), { headers });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    const err = new Error(`上游返回 ${r.status}`);
    err.status = r.status;
    err.detail = detail.slice(0, 300);
    throw err;
  }
  const data = await r.json();
  if (spec.modelsPick) return spec.modelsPick(data).sort();
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return list.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean).sort();
}

module.exports = {
  DONE,
  SPECS,
  SPEC_IDS,
  detectSpec,
  resolveSpec,
  buildRequest,
  parseDelta,
  extractText,
  listModels,
};
