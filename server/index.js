// Missive 后端。
//  - 静态托管 ../web
//  - GET/POST /api/settings：设置的读写（API配置/人设/速度/字体）
//  - POST /interpret：接收 PNG 笔迹，转发给 OpenAI 兼容视觉模型，流式回传 SSE
//
// 可作为独立 Node 服务跑（`node index.js`，监听 0.0.0.0，供局域网设备访问），
// 也可被 Electron 主进程 require() 后自行 listen(127.0.0.1) 做成桌面版——两边共用同一套逻辑。

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const settingsStore = require('./settings');
const history = require('./history');
const { INSTRUCTION } = require('./persona');

const DATA_DIR = process.env.SETTINGS_DIR || __dirname;
const BACKGROUND_PATH = path.join(DATA_DIR, 'background.jpg');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '12mb' })); // 背景图走 base64 JSON，得留够空间
  // 笔迹 PNG 通过裸body上传，体积小（<几百KB），内存暂存即可
  app.use(express.raw({ type: 'image/*', limit: '4mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '4mb' }));

  const WEB_DIR = path.join(__dirname, '..', 'web');
  app.use(express.static(WEB_DIR));

  // ─── 设置读写 ────────────────────────────────────
  // profiles 里的 apiKey 永远不回传给前端，只回传 hasKey 布尔值
  const publicProfile = (p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!p.apiKey });

  app.get('/api/settings', (req, res) => {
    const s = settingsStore.load();
    res.json({
      profiles: s.profiles.map(publicProfile),
      activeProfileId: s.activeProfileId,
      maxTokens: s.maxTokens,
      promptCards: s.promptCards,
      font: s.font,
      speed: s.speed,
      hintText: s.hintText,
      theme: s.theme,
      hasCustomBackground: fs.existsSync(BACKGROUND_PATH),
      contextTurns: s.contextTurns,
      contextCount: history.recentContext(s.contextResetAt, s.contextTurns).length,
      autoSendEnabled: s.autoSendEnabled,
      autoSendSeconds: s.autoSendSeconds,
      fadeSeconds: s.fadeSeconds,
      lingerSeconds: s.lingerSeconds,
      inkLingerSeconds: s.inkLingerSeconds,
      inkFadeSeconds: s.inkFadeSeconds,
      penOnly: s.penOnly,
      brush: s.brush,
    });
  });

  // 重置对话：之后的请求不再把重置点之前的历史当上下文（历史本身不删）。
  // 可选 summarize:true——重置前先让AI把最近这段对话总结成一张"长期记忆"卡片。
  app.post('/api/context/reset', async (req, res) => {
    const s = settingsStore.load();
    const summarize = !!(req.body || {}).summarize;
    let memoryCard = null;

    if (summarize) {
      const profile = settingsStore.activeProfile(s);
      if (!profile.apiKey || !profile.baseUrl || !profile.model) {
        return res.status(400).json({ error: '还没配置 API，没法总结' });
      }
      const entries = history.recentContext(s.contextResetAt, s.contextTurns || 10);
      if (entries.length === 0) {
        return res.status(400).json({ error: '目前还没有可以总结的对话内容' });
      }
      try {
        const summary = await requestSummary(profile, entries);
        memoryCard = settingsStore.upsertLongTermMemoryCard(s, summary.trim());
      } catch (e) {
        return res.status(502).json({ error: '总结失败: ' + e.message });
      }
    }

    s.contextResetAt = new Date().toISOString();
    settingsStore.save(s);
    res.json({ ok: true, contextResetAt: s.contextResetAt, memoryCard });
  });

  // ─── 自定义背景图 ─────────────────────────────────
  app.post('/api/background', (req, res) => {
    const dataUrl = (req.body || {}).imageDataUrl || '';
    const m = /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ error: '图片格式不对，得是 PNG 或 JPEG' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: '图片太大了（超过6MB）' });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BACKGROUND_PATH, buf);
    res.json({ ok: true });
  });

  app.get('/api/background-image', (req, res) => {
    if (!fs.existsSync(BACKGROUND_PATH)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(BACKGROUND_PATH).pipe(res);
  });

  // 全局设置（人设/速度/字体/回答长度/首屏提示/背景主题/切换当前配置）
  app.post('/api/settings', (req, res) => {
    const s = settingsStore.load();
    const body = req.body || {};
    const next = { ...s };
    if (typeof body.maxTokens === 'number' && body.maxTokens > 0) next.maxTokens = Math.round(body.maxTokens);
    if (typeof body.font === 'string') next.font = body.font;
    if (typeof body.speed === 'number') next.speed = Math.max(1, Math.min(10, body.speed));
    if (typeof body.hintText === 'string') next.hintText = body.hintText;
    if (typeof body.theme === 'string') next.theme = body.theme;
    if (typeof body.autoSendEnabled === 'boolean') next.autoSendEnabled = body.autoSendEnabled;
    if (typeof body.autoSendSeconds === 'number' && body.autoSendSeconds > 0) {
      next.autoSendSeconds = Math.max(0.5, Math.min(20, body.autoSendSeconds));
    }
    if (typeof body.fadeSeconds === 'number' && body.fadeSeconds > 0) {
      next.fadeSeconds = Math.max(0.3, Math.min(8, body.fadeSeconds));
    }
    if (typeof body.lingerSeconds === 'number' && body.lingerSeconds > 0) {
      next.lingerSeconds = Math.max(1, Math.min(15, body.lingerSeconds));
    }
    if (typeof body.inkLingerSeconds === 'number' && body.inkLingerSeconds > 0) {
      next.inkLingerSeconds = Math.max(0.5, Math.min(10, body.inkLingerSeconds));
    }
    if (typeof body.inkFadeSeconds === 'number' && body.inkFadeSeconds > 0) {
      next.inkFadeSeconds = Math.max(0.3, Math.min(6, body.inkFadeSeconds));
    }
    if (typeof body.penOnly === 'boolean') next.penOnly = body.penOnly;
    if (body.brush && typeof body.brush === 'object') {
      next.brush = { ...s.brush, ...body.brush };
    }
    if (typeof body.activeProfileId === 'string' && s.profiles.some((p) => p.id === body.activeProfileId)) {
      next.activeProfileId = body.activeProfileId;
    }
    settingsStore.save(next);
    res.json({ ok: true });
  });

  // ─── 提示词卡片（人设/长期记忆/其他）─────────────
  app.post('/api/cards', (req, res) => {
    const s = settingsStore.load();
    const body = req.body || {};
    if (!settingsStore.CARD_CATEGORIES.includes(body.category)) {
      return res.status(400).json({ error: '未知的卡片类别' });
    }
    const card = settingsStore.newCard({
      category: body.category,
      title: (body.title || '新卡片').trim(),
      content: body.content || '',
      enabled: body.enabled !== false,
    });
    s.promptCards.push(card);
    settingsStore.save(s);
    res.json({ ok: true, card });
  });

  app.put('/api/cards/:id', (req, res) => {
    const s = settingsStore.load();
    const card = s.promptCards.find((c) => c.id === req.params.id);
    if (!card) return res.status(404).json({ error: '卡片不存在' });
    const body = req.body || {};
    if (typeof body.title === 'string') card.title = body.title.trim() || card.title;
    if (typeof body.content === 'string') card.content = body.content;
    if (typeof body.enabled === 'boolean') card.enabled = body.enabled;
    settingsStore.save(s);
    res.json({ ok: true, card });
  });

  app.delete('/api/cards/:id', (req, res) => {
    const s = settingsStore.load();
    const idx = s.promptCards.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '卡片不存在' });
    s.promptCards.splice(idx, 1);
    settingsStore.save(s);
    res.json({ ok: true });
  });

  // ─── 历史记录（存档：翻看/删除）───────────────────
  app.get('/api/history', (req, res) => {
    res.json(history.load().slice().reverse());
  });

  app.delete('/api/history/:id', (req, res) => {
    history.remove(req.params.id);
    res.json({ ok: true });
  });

  // ─── 配置槽位（多套 API 配置）───────────────────
  app.post('/api/profiles', (req, res) => {
    const s = settingsStore.load();
    const body = req.body || {};
    const p = settingsStore.newProfile({
      name: (body.name || '新配置').trim(),
      baseUrl: (body.baseUrl || '').trim(),
      apiKey: (body.apiKey || '').trim(),
      model: (body.model || '').trim(),
    });
    s.profiles.push(p);
    s.activeProfileId = p.id;
    settingsStore.save(s);
    res.json({ ok: true, profile: publicProfile(p) });
  });

  app.put('/api/profiles/:id', (req, res) => {
    const s = settingsStore.load();
    const p = s.profiles.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '配置不存在' });
    const body = req.body || {};
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
    if (typeof body.baseUrl === 'string') p.baseUrl = body.baseUrl.trim();
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) p.apiKey = body.apiKey.trim();
    if (typeof body.model === 'string') p.model = body.model.trim();
    settingsStore.save(s);
    res.json({ ok: true, profile: publicProfile(p) });
  });

  app.delete('/api/profiles/:id', (req, res) => {
    const s = settingsStore.load();
    if (s.profiles.length <= 1) {
      return res.status(400).json({ error: '至少要留一个配置' });
    }
    const idx = s.profiles.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '配置不存在' });
    s.profiles.splice(idx, 1);
    if (s.activeProfileId === req.params.id) s.activeProfileId = s.profiles[0].id;
    settingsStore.save(s);
    res.json({ ok: true, activeProfileId: s.activeProfileId });
  });

  // 拉取某个 OpenAI 兼容端点支持的模型列表，填模型名的时候可以直接选，不用手打
  app.post('/api/models', async (req, res) => {
    const body = req.body || {};
    let baseUrl = (body.baseUrl || '').trim();
    let apiKey = (body.apiKey || '').trim();
    if ((!baseUrl || !apiKey) && body.profileId) {
      const s = settingsStore.load();
      const p = s.profiles.find((x) => x.id === body.profileId);
      if (p) {
        baseUrl = baseUrl || p.baseUrl;
        apiKey = apiKey || p.apiKey;
      }
    }
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: '缺少 API 基础URL 或密钥' });
    }
    try {
      const url = baseUrl.replace(/\/$/, '') + '/models';
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(r.status).json({ error: `上游返回 ${r.status}`, detail: detail.slice(0, 300) });
      }
      const data = await r.json();
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models = list.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ─── POST /interpret ──────────────────────────────
  // 请求体：裸 PNG（Content-Type: image/png 或 application/octet-stream）
  // 响应：text/event-stream，每行 data: {token}\n\n，结束时 data: [DONE]
  app.post('/interpret', async (req, res) => {
    const pngBuffer = req.body;
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length < 8) {
      return res.status(400).json({ error: '未收到有效的图片数据（应为 PNG，Content-Type: image/png）' });
    }

    const s = settingsStore.load();
    const profile = settingsStore.activeProfile(s);
    if (!profile.apiKey || !profile.baseUrl || !profile.model) {
      return res.status(400).json({ error: '还没配置 API，请先点右上角齿轮打开设置' });
    }

    // 组装 Responses API 请求（中转站是 Codex 专用，只允许 /v1/responses 端点）。
    const base64 = pngBuffer.toString('base64');
    const currentImageDataUrl = `data:image/png;base64,${base64}`;

    // 滚动上下文：把最近几轮（用户写的图/打的字 + AI当时的回复）一起发过去，AI才能接得上话。
    // 用户手动"重置对话"之后，重置点之前的历史就不会再被算进去了。
    const contextEntries = history.recentContext(s.contextResetAt, s.contextTurns || 10);
    const contextInput = buildContextInput(contextEntries);

    const payload = {
      model: profile.model,
      stream: true,
      max_output_tokens: parseInt(s.maxTokens, 10) || 280,
      instructions: settingsStore.buildInstructions(s),
      input: [...contextInput, {
        role: 'user',
        content: [
          { type: 'input_text', text: INSTRUCTION },
          { type: 'input_image', image_url: currentImageDataUrl },
        ],
      }],
    };

    // 上游请求（流式，带重试）：中转站对图片请求会高频 403，需要多次重试 + 指数退避
    let upstream = null;
    const MAX_RETRIES = 8;
    const upstreamUrl = `${profile.baseUrl.replace(/\/$/, '')}/responses`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${profile.apiKey}`,
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

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let tokenCount = 0;
    let fullText = '';
    const startedAt = Date.now();

    // 流跑完了：把这一轮存进历史，下一轮才能接上上下文
    const saveTurn = () => {
      if (fullText.trim()) {
        history.append({ kind: 'ink', imageDataUrl: currentImageDataUrl, reply: fullText });
      }
    };

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
            saveTurn();
            return res.end();
          }
          if (result) {
            tokenCount++;
            fullText += result;
            res.write(`data: ${JSON.stringify(result)}\n\n`);
          }
        }
      }
      res.write('data: [DONE]\n\n');
      console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
      saveTurn();
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

  // ─── POST /interpret-text ─────────────────────────
  // 打字模式：请求体是 JSON { text }，不是图片。流程和 /interpret 完全一样，
  // 只是"这一轮"用 input_text 而不是 input_image；历史里记的 kind 也是 'typed'。
  app.post('/interpret-text', async (req, res) => {
    const text = ((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: '没有收到文字内容' });

    const s = settingsStore.load();
    const profile = settingsStore.activeProfile(s);
    if (!profile.apiKey || !profile.baseUrl || !profile.model) {
      return res.status(400).json({ error: '还没配置 API，请先点右上角齿轮打开设置' });
    }

    const contextEntries = history.recentContext(s.contextResetAt, s.contextTurns || 10);
    const contextInput = buildContextInput(contextEntries);

    // 人设卡片默认是围绕"看图读墨迹"写的（"如果字迹潦草……看不清就说看不清"），
    // 打字模式没有图片，得追一句提示，不然AI容易莫名其妙地说"看不清"。
    const TYPED_MODE_NOTE = '（提示：这一次对方是直接打字发给你的，不是手写照片，正常回应文字内容即可，不要说"看不清"、"字迹模糊"之类只适用于图片的话。）';

    const payload = {
      model: profile.model,
      stream: true,
      max_output_tokens: parseInt(s.maxTokens, 10) || 280,
      instructions: settingsStore.buildInstructions(s) + '\n\n' + TYPED_MODE_NOTE,
      input: [...contextInput, { role: 'user', content: [{ type: 'input_text', text }] }],
    };

    let upstream = null;
    const MAX_RETRIES = 8;
    const upstreamUrl = `${profile.baseUrl.replace(/\/$/, '')}/responses`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${profile.apiKey}`,
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

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let tokenCount = 0;
    let fullText = '';
    const startedAt = Date.now();

    const saveTurn = () => {
      if (fullText.trim()) {
        history.append({ kind: 'typed', userText: text, reply: fullText });
      }
    };

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
            saveTurn();
            return res.end();
          }
          if (result) {
            tokenCount++;
            fullText += result;
            res.write(`data: ${JSON.stringify(result)}\n\n`);
          }
        }
      }
      res.write('data: [DONE]\n\n');
      console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
      saveTurn();
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

  return app;
}

const DONE = Symbol('done');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 把一条历史记录变成 Responses API 的一轮 input（用户那半 + AI回复那半）。
// 手写来的用 input_image，打字/导入图片是另外两种来源，分别对应 input_text / input_image。
function buildContextTurn(entry) {
  const userContent = entry.kind === 'typed'
    ? [{ type: 'input_text', text: entry.userText || '' }]
    : [{ type: 'input_image', image_url: entry.imageDataUrl }];
  return [
    { role: 'user', content: userContent },
    { role: 'assistant', content: [{ type: 'output_text', text: entry.reply }] },
  ];
}

function buildContextInput(entries) {
  return entries.flatMap(buildContextTurn);
}

const SUMMARY_PROMPT = '请把以上这些互动内容总结成一段简短的长期记忆备注，帮助你以后回忆起对方是谁、聊过什么、有什么值得记住的事或偏好。控制在150字以内，不分点、不用markdown，就写成一段随手记的备注。';

// 让AI把最近几轮对话总结成一段话，用于生成"长期记忆"卡片。复用 /interpret 同款的
// 流式请求 + 重试逻辑，只是这里在服务端把整段流吃完再一次性返回文本，不转发给前端。
async function requestSummary(profile, contextEntries) {
  const input = buildContextInput(contextEntries);
  input.push({ role: 'user', content: [{ type: 'input_text', text: SUMMARY_PROMPT }] });

  const payload = { model: profile.model, stream: true, max_output_tokens: 300, input };
  const url = `${profile.baseUrl.replace(/\/$/, '')}/responses`;

  let upstream = null;
  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey}`,
          'User-Agent': 'codex_cli_rs/0.45.0',
          'originator': 'codex_cli_rs',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(400 * attempt);
      continue;
    }
    if (upstream.ok && upstream.body) break;
    if ((upstream.status === 403 || upstream.status === 429 || upstream.status === 500) && attempt < MAX_RETRIES) {
      await sleep(800 * attempt);
      upstream = null;
      continue;
    }
    const detail = await upstream.text().catch(() => '');
    throw new Error(`上游返回 ${upstream.status}: ${detail.slice(0, 200)}`);
  }
  if (!upstream || !upstream.body) throw new Error('没拿到模型响应');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = sseBuffer.indexOf('\n\n')) !== -1) {
      const block = sseBuffer.slice(0, nl);
      sseBuffer = sseBuffer.slice(nl + 2);
      const result = extractResponsesDelta(block);
      if (result === DONE) return fullText;
      if (result) fullText += result;
    }
  }
  return fullText;
}

// 从 Responses API 的 SSE 事件块里提取输出文本增量
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

// 启动服务。port=0 让系统分配空闲端口（桌面版用）。
function start(port, host) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    const addr = server.address();
    if (host === '0.0.0.0') {
      const lanIps = [];
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
        }
      }
      console.log(`\nMissive 已启动:`);
      console.log(`  本机访问: http://localhost:${addr.port}`);
      for (const ip of lanIps) console.log(`  同一WiFi设备访问: http://${ip}:${addr.port}`);
      console.log('');
    } else {
      console.log(`\nMissive 已启动: http://${host}:${addr.port}\n`);
    }
  });
  return server;
}

module.exports = { createApp, start };

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  start(PORT, '0.0.0.0');
}
