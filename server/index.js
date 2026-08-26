// Missive 后端。
//  - 静态托管 ../web
//  - GET/POST /api/settings：设置的读写（API配置/人设/速度/字体）
//  - POST /interpret：接收 PNG 笔迹，转发给视觉模型，流式回传 SSE
//
// 上游发什么形状、回来怎么拆，全在 ./providers.js 里按接口规范分开写
// （OpenAI Responses / OpenAI Chat Completions / Anthropic Messages / Google Gemini）。
// 这个文件只组装一份中立请求，不关心对面是谁。
//
// 可作为独立 Node 服务跑（`node index.js`，监听 0.0.0.0，供局域网设备访问），
// 也可被 Electron 主进程 require() 后自行 listen(127.0.0.1) 做成桌面版——两边共用同一套逻辑。

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const shared = require('./shared');
const settingsStore = require('./settings');
const history = require('./history');
const providers = require('./providers');
const convo = () => shared.get('conversation'); // 提示词文案和上下文拼装，跟手机版共用
const persona = require('./persona'); // 转接头，取值要在 shared.load() 之后，见 ./shared.js

const DATA_DIR = process.env.SETTINGS_DIR || __dirname;
const BACKGROUND_PATH = path.join(DATA_DIR, 'background.jpg');
const cjkFontPath = (ext) => path.join(DATA_DIR, 'cjk-font.' + ext);

function createApp() {
  const app = express();
  app.use(express.json({ limit: '40mb' })); // 背景图/自定义字体都走 base64 JSON，中文字体文件常有 20MB+，得留够空间
  // 笔迹 PNG 通过裸body上传，体积小（<几百KB），内存暂存即可
  app.use(express.raw({ type: 'image/*', limit: '4mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '4mb' }));

  const WEB_DIR = path.join(__dirname, '..', 'web');
  app.use(express.static(WEB_DIR));

  // 页面开机时探这一下，决定自己是走服务还是本地存储，见 web/src/api.js。
  // 必须自报家门：静态托管会拿首页去应付找不到的路径，那也是 200，光看状态码分不出来。
  app.get('/api/health', (req, res) => res.json({ missive: true }));

  // ─── 设置读写 ────────────────────────────────────
  // profiles 里的 apiKey 永远不回传给前端，只回传 hasKey 布尔值
  // resolvedSpec 是"选自动识别时，现在这个 URL 会被判成哪种"，给设置页显示用
  const publicProfile = (p) => settingsStore.publicProfile(p);

  // 给页面的那份投影（不含密钥）由 settings-model 拼，跟手机版是同一份代码。
  // 这里只补上"存储那边才知道的事"——有没有存过背景图/字体、上下文攒了几条。
  app.get('/api/settings', (req, res) => {
    const s = settingsStore.load();
    res.json(settingsStore.publicSettings(s, {
      hintText: settingsStore.resolveHintText(s),
      hasCustomBackground: fs.existsSync(BACKGROUND_PATH),
      hasCjkFont: !!(s.cjkFontExt && fs.existsSync(cjkFontPath(s.cjkFontExt))),
      contextCount: history.recentContext(s.contextResetAt, s.contextTurns).length,
    }));
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
    s.conversationId = (s.conversationId || 1) + 1;
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

  // ─── 自定义中文手写字体 ───────────────────────────
  // 上传/桌面版从系统字体库选，走的是同一个接口——不管字体文件从哪来，
  // 到这里都是 {filename, fontDataBase64}，处理逻辑完全一样。
  app.post('/api/cjk-font', (req, res) => {
    const body = req.body || {};
    const filename = String(body.filename || '').toLowerCase();
    const m = /\.(ttf|otf|ttc)$/.exec(filename);
    if (!m) return res.status(400).json({ error: '只支持 .ttf / .otf / .ttc 字体文件' });
    const ext = m[1];
    const base64 = String(body.fontDataBase64 || '');
    if (!base64) return res.status(400).json({ error: '没收到字体数据' });
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: '字体数据格式不对' });
    }
    if (buf.length < 100) return res.status(400).json({ error: '字体文件看起来是空的' });
    if (buf.length > 30 * 1024 * 1024) return res.status(400).json({ error: '字体文件太大了（超过30MB）' });

    const s = settingsStore.load();
    if (s.cjkFontExt) {
      try { fs.unlinkSync(cjkFontPath(s.cjkFontExt)); } catch {} // 换字体了，把上一个（可能不同后缀）删掉，别攒垃圾
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(cjkFontPath(ext), buf);
    s.cjkFont = 'custom';
    s.cjkFontExt = ext;
    s.cjkFontName = body.filename || ('自定义字体.' + ext);
    settingsStore.save(s);
    res.json({ ok: true, cjkFontName: s.cjkFontName });
  });

  app.get('/api/cjk-font-file', (req, res) => {
    const s = settingsStore.load();
    if (!s.cjkFontExt) return res.status(404).end();
    const p = cjkFontPath(s.cjkFontExt);
    if (!fs.existsSync(p)) return res.status(404).end();
    const mime = s.cjkFontExt === 'otf' ? 'font/otf' : s.cjkFontExt === 'ttc' ? 'font/collection' : 'font/ttf';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(p).pipe(res);
  });

  app.delete('/api/cjk-font', (req, res) => {
    const s = settingsStore.load();
    if (s.cjkFontExt) {
      try { fs.unlinkSync(cjkFontPath(s.cjkFontExt)); } catch {}
    }
    s.cjkFont = 'default';
    s.cjkFontExt = null;
    s.cjkFontName = '';
    settingsStore.save(s);
    res.json({ ok: true });
  });

  // 全局设置（人设/速度/字体/回答长度/首屏提示/背景主题/切换当前配置）
  app.post('/api/settings', (req, res) => {
    const s = settingsStore.load();
    settingsStore.save(settingsStore.applySettingsPatch(s, req.body || {}));
    res.json({ ok: true });
  });

  // ─── 提示词卡片（人设/长期记忆/其他）─────────────
  app.post('/api/cards', (req, res) => {
    const s = settingsStore.load();
    const body = req.body || {};
    if (!settingsStore.ALL_CARD_CATEGORIES.includes(body.category)) {
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
    settingsStore.applyCardPatch(card, req.body || {});
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
    const p = settingsStore.profileFromInput(body);
    s.profiles.push(p);
    s.activeProfileId = p.id;
    settingsStore.save(s);
    res.json({ ok: true, profile: publicProfile(p) });
  });

  app.put('/api/profiles/:id', (req, res) => {
    const s = settingsStore.load();
    const p = s.profiles.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '配置不存在' });
    settingsStore.applyProfilePatch(p, req.body || {});
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

  // 拉取某个端点支持的模型列表，填模型名的时候可以直接选，不用手打。
  // 请求走的是"设置页里此刻填着的值"，还没保存也能试——所以 spec 也一起从前端带过来。
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
    const spec = (body.spec === 'auto' || providers.SPECS[body.spec]) ? body.spec : 'auto';
    try {
      const models = await providers.listModels({ baseUrl, apiKey, spec });
      res.json({ models });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message, detail: e.detail });
    }
  });

  // ─── POST /api/poke-lines/generate ────────────────
  // 让 AI 照当前人设，把"戳写字页那个图标"时的五档反应写一遍，存进 settings.pokeLines。
  // 设置页里那个「磨合」按钮按一下就走这里，一次一个请求——故意没绑在保存人设上，
  // 免得改个错别字就悄悄花掉一次调用。
  //
  // 生成结果不回给前端展示：这是彩蛋，内容只能靠一下下戳出来。写砸了就再按一次。
  app.post('/api/poke-lines/generate', async (req, res) => {
    const s = settingsStore.load();
    const profile = settingsStore.activeProfile(s);
    if (!profile.apiKey || !profile.baseUrl || !profile.model) {
      return res.status(400).json({ error: '还没配置 API' });
    }    // 跟应用里其它请求一样走流式，只是这边不往外转发、整段吃完再一次性解析。
    // 曾经这一处是唯一一个不流式的请求，跟手机版那套对不上；两边走同一条路才好改。
    const request = {
      stream: true,
      maxTokens: 800,
      instructions: settingsStore.buildInstructions(s),
      turns: [{ role: 'user', parts: [{ type: 'text', text: convo().ATTUNE_TASK }] }],
    };

    let text;
    try {
      // 不重试：这是彩蛋，失败了再按一次就行，不值得替用户多花几次调用
      const upstream = await postUpstream(profile, request, { maxRetries: 1 });
      text = await shared.get('upstream').readAllText(upstream, profile);
    } catch (e) {
      return sendUpstreamError(res, e);
    }

    const parsed = convo().parseAttuneResult(text);
    // 戳的那五档是这次的主菜，它没解析出来就整个算失败——保留原有的，绝不写半套进去。
    // 三种托辞是各自独立的，谁能用就换谁，剩下的继续用内置那份。
    if (!parsed || !parsed.poke) {
      return res.status(422).json({ error: '模型没给出可用的格式' });
    }
    s.pokeLines = parsed.poke;
    if (parsed.fallback) s.fallbackLines = { ...(s.fallbackLines || {}), ...parsed.fallback };
    settingsStore.save(s);
    res.json({ ok: true });
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
      return res.status(400).json({ error: '还没配置 API，请先点右上角的设置图标填一下' });
    }

    const base64 = pngBuffer.toString('base64');
    const currentImageDataUrl = `data:image/png;base64,${base64}`;

    // 滚动上下文：把最近几轮（用户写的图/打的字 + AI当时的回复）一起发过去，AI才能接得上话。
    // 用户手动"重置对话"之后，重置点之前的历史就不会再被算进去了。
    const contextEntries = history.recentContext(s.contextResetAt, s.contextTurns || 10);

    const request = {
      stream: true,
      maxTokens: parseInt(s.maxTokens, 10) || 280,
      instructions: settingsStore.buildInstructions(s),
      turns: [...convo().buildContextTurns(contextEntries), {
        role: 'user',
        parts: [
          { type: 'text', text: persona.INSTRUCTION },
          { type: 'image', dataUrl: currentImageDataUrl },
        ],
      }],
    };

    let upstream;
    try {
      upstream = await postUpstream(profile, request);
    } catch (e) {
      return sendUpstreamError(res, e);
    }

    // 流跑完了：把这一轮存进历史，下一轮才能接上上下文
    await pipeStream(res, upstream, profile, (fullText) => {
      if (fullText.trim()) {
        history.append({ kind: 'ink', imageDataUrl: currentImageDataUrl, reply: fullText, conversationId: s.conversationId || 1 });
      }
    });
  });

  // ─── POST /interpret-text ─────────────────────────
  // 打字模式：请求体是 JSON { text }，不是图片。流程和 /interpret 完全一样，
  // 只是"这一轮"发的是文字而不是图片；历史里记的 kind 也是 'typed'。
  app.post('/interpret-text', async (req, res) => {
    const text = ((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: '没有收到文字内容' });

    const s = settingsStore.load();
    const profile = settingsStore.activeProfile(s);
    if (!profile.apiKey || !profile.baseUrl || !profile.model) {
      return res.status(400).json({ error: '还没配置 API，请先点右上角的设置图标填一下' });
    }

    const contextEntries = history.recentContext(s.contextResetAt, s.contextTurns || 10);

    // 人设卡片默认是围绕"看图读墨迹"写的（"如果字迹潦草……看不清就说看不清"），
    // 打字模式没有图片，得追一句提示，不然AI容易莫名其妙地说"看不清"。

    const request = {
      stream: true,
      maxTokens: parseInt(s.maxTokens, 10) || 280,
      instructions: settingsStore.buildInstructions(s) + '\n\n' + convo().TYPED_MODE_NOTE,
      turns: [...convo().buildContextTurns(contextEntries), { role: 'user', parts: [{ type: 'text', text }] }],
    };

    let upstream;
    try {
      upstream = await postUpstream(profile, request);
    } catch (e) {
      return sendUpstreamError(res, e);
    }

    await pipeStream(res, upstream, profile, (fullText) => {
      if (fullText.trim()) {
        history.append({ kind: 'typed', userText: text, reply: fullText, conversationId: s.conversationId || 1 });
      }
    });
  });

  return app;
}

// 发请求、退避重试的逻辑在 web/src/shared/upstream.js，跟手机版共用。
// 这里只多挂一个打日志的旁观者——浏览器里不需要往控制台刷这些。
function postUpstream(profile, request, opts = {}) {
  return shared.get('upstream').postUpstream(profile, request, {
    ...opts,
    onRetry: (msg) => console.error(msg),
  });
}

function sendUpstreamError(res, e) {
  return res.status(e.status || 502).json({ error: e.message, detail: e.detail });
}

// 把上游的流按当前规范拆成纯文本增量，逐段转成本应用自己那套 SSE
// （每行 data: {token}，结束时 data: [DONE]）。前端只认这一种形状，跟上游是谁无关。
// onFinish 拿到的是这一轮的完整文本，用来落历史。
async function pipeStream(res, upstream, profile, onFinish) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let tokenCount = 0;
  let fullText = '';
  const startedAt = Date.now();

  try {
    // 拆流的逻辑在 web/src/shared/upstream.js，跟手机版共用
    for await (const piece of shared.get('upstream').readTokens(upstream, profile)) {
      tokenCount++;
      fullText += piece;
      res.write(`data: ${JSON.stringify(piece)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
    onFinish(fullText);
    res.end();
  } catch (err) {
    console.error('转发中断:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '转发中断', detail: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch {}
    }
  }
}

// 让AI把最近几轮对话总结成一段话，用于生成"长期记忆"卡片。复用 /interpret 同款的
// 流式请求 + 重试逻辑，只是这里把整段流吃完再一次性返回文本，不转发给前端。
async function requestSummary(profile, contextEntries) {
  const request = {
    stream: true,
    maxTokens: 300,
    turns: [
      ...convo().buildContextTurns(contextEntries),
      { role: 'user', parts: [{ type: 'text', text: convo().SUMMARY_PROMPT }] },
    ],
  };
  const upstream = await postUpstream(profile, request, { maxRetries: 4 });
  return shared.get('upstream').readAllText(upstream, profile);
}

// 先 await 加载后端和手机版共用的那几个模块（见 ./shared.js），再开始监听。
// 返回的 Promise 在真正 listening 之后才 resolve，调用方拿到手就能读 address()。
async function start(port, host) {
  await shared.load();
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
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server;
}

module.exports = { createApp, start };

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  start(PORT, '0.0.0.0').catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}
