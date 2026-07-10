// 墨问后端：一个文件搞定。
//  - 静态托管 ../web（Boox 浏览器打开 http://<电脑IP>:3000）
//  - POST /interpret：接收 PNG 笔迹，转发给 OpenAI 兼容视觉模型，流式回传 SSE
//
// API key 只在本进程的 .env 里，永不发给前端。

const path = require('path');
const express = require('express');
const { PERSONA, INSTRUCTION } = require('./persona');

// dotenv 必须在读取 env 之前加载
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  OPENAI_MODEL = 'gpt-4o-mini',
  MAX_TOKENS = '280',
  PORT = '3000',
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('\n❌ 未设置 OPENAI_API_KEY。请复制 .env.example 为 .env 并填入你的 key。\n');
  process.exit(1);
}

const app = express();
// 笔迹 PNG 通过 multipart 上传，体积小（<几百KB），用内存暂存即可
app.use(express.raw({ type: 'image/*', limit: '4mb' }));
// 也接受 application/octet-stream 的裸 PNG
app.use(express.raw({ type: 'application/octet-stream', limit: '4mb' }));

// ─── 静态托管前端 ─────────────────────────────────────────────
const WEB_DIR = path.join(__dirname, '..', 'web');
app.use(express.static(WEB_DIR));

// ─── POST /interpret ──────────────────────────────────────────
// 请求体：裸 PNG（Content-Type: image/png 或 application/octet-stream）
// 响应：text/event-stream，每行 data: {token}\n\n，结束时 data: [DONE]
//
// 前端用 ReadableStream 读取，按句断句后逐句送给手写动画。
app.post('/interpret', async (req, res) => {
  const pngBuffer = req.body;
  // 必须是 Buffer 且有足够长度（PNG 至少 8 字节头）。空 body / 错误类型一律 400。
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length < 8) {
    return res.status(400).json({ error: '未收到有效的图片数据（应为 PNG，Content-Type: image/png）' });
  }

  // 组装 Responses API 请求（中转站是 Codex 专用，只允许 /v1/responses 端点）。
  // 人设放进 instructions（对应 system 角色）；图片和提示语作为 user input。
  const base64 = pngBuffer.toString('base64');
  const payload = {
    model: OPENAI_MODEL,
    stream: true,
    max_output_tokens: parseInt(MAX_TOKENS, 10),
    instructions: PERSONA,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: INSTRUCTION },
        { type: 'input_image', image_url: `data:image/png;base64,${base64}` },
      ],
    }],
  };

  // 上游请求（流式，带重试）：中转站对图片请求会高频 403，需要多次重试 + 指数退避
  let upstream = null;
  const MAX_RETRIES = 8;
  const upstreamUrl = `${OPENAI_BASE_URL.replace(/\/$/, '')}/responses`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'User-Agent': 'codex_cli_rs/0.45.0',
          'originator': 'codex_cli_rs',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error(`第${attempt}次连接失败:`, err.message);
      if (attempt === MAX_RETRIES) {
        return res.status(502).json({ error: '无法连接模型服务', detail: err.message });
      }
      await sleep(300 * attempt);
      continue;
    }
    if (upstream.ok && upstream.body) break;
    const detail = await upstream.text().catch(() => '');
    if ((upstream.status === 403 || upstream.status === 429 || upstream.status === 500) && attempt < MAX_RETRIES) {
      // 指数退避：1s, 2s, 3s, 4s... 给中转站的限流窗口时间恢复
      console.error(`第${attempt}次上游 ${upstream.status}，${attempt}s 后重试`);
      await sleep(1000 * attempt);
      upstream = null;
      continue;
    }
    console.error(`上游 ${upstream.status}:`, detail.slice(0, 300));
    return res.status(upstream.status).json({ error: '模型服务返回错误', detail });
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    return res.status(502).json({ error: '多次重试后仍无法获取模型响应' });
  }

  // 开始向下游回传 SSE
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 解析上游 Responses API 的 SSE：
  //   event: response.output_text.delta   data: {..., delta: "文字"}
  //   event: response.completed           data: {...}
  // 提取 delta 字段，逐 token 转发给前端；收到 completed 即结束。
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let tokenCount = 0;
  const startedAt = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = sseBuffer.indexOf('\n\n')) !== -1) {
        const eventBlock = sseBuffer.slice(0, nl);
        sseBuffer = sseBuffer.slice(nl + 2);
        const result = extractResponsesDelta(eventBlock);
        if (result === DONE) {
          res.write('data: [DONE]\n\n');
          console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
          return res.end();
        }
        if (result) {
          tokenCount++;
          res.write(`data: ${JSON.stringify(result)}\n\n`);
        }
      }
    }
    res.write('data: [DONE]\n\n');
    console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
    res.end();
  } catch (err) {
    console.error('转发中断:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '转发中断', detail: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch {}
    }
  }
});

const DONE = Symbol('done');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 从 Responses API 的 SSE 事件块里提取输出文本增量
// 关键事件：event: response.output_text.delta → data.delta
//           event: response.completed         → 结束
function extractResponsesDelta(eventBlock) {
  let eventName = '';
  let dataLine = '';
  for (const line of eventBlock.split('\n')) {
    const t = line.trim();
    if (t.startsWith('event:')) eventName = t.slice(6).trim();
    else if (t.startsWith('data:')) dataLine = t.slice(5).trim();
  }
  if (eventName === 'response.completed' || eventName === 'response.failed' || dataLine === '[DONE]') {
    return DONE;
  }
  if (eventName === 'response.output_text.delta' && dataLine) {
    try {
      const obj = JSON.parse(dataLine);
      if (typeof obj.delta === 'string') return obj.delta;
    } catch {}
  }
  return null;
}

// ─── 启动 ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  墨问 ink-diary                              ║
╠══════════════════════════════════════════════╣
║  前端:  http://<本机IP>:${PORT.padStart(5)}            ║
║  模型:  ${OPENAI_MODEL.padEnd(34)}║
║  监听:  0.0.0.0:${PORT}                        ║
╚══════════════════════════════════════════════╝
  在 Boox 浏览器打开上面的地址，然后"添加到主屏幕"。
`);
});
