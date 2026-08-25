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
const settingsStore = require('./settings');
const history = require('./history');
const providers = require('./providers');
const { INSTRUCTION } = require('./persona');

const DONE = providers.DONE;

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

  // ─── 设置读写 ────────────────────────────────────
  // profiles 里的 apiKey 永远不回传给前端，只回传 hasKey 布尔值
  // resolvedSpec 是"选自动识别时，现在这个 URL 会被判成哪种"，给设置页显示用
  const publicProfile = (p) => ({
    id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!p.apiKey,
    spec: p.spec || 'auto', resolvedSpec: providers.resolveSpec(p),
  });

  app.get('/api/settings', (req, res) => {
    const s = settingsStore.load();
    res.json({
      profiles: s.profiles.map(publicProfile),
      activeProfileId: s.activeProfileId,
      maxTokens: s.maxTokens,
      promptCards: s.promptCards,
      font: s.font,
      speed: s.speed,
      hintText: settingsStore.resolveHintText(s),
      theme: s.theme,
      themeColor: s.themeColor,
      bgColor: s.bgColor,
      chromeTheme: s.chromeTheme,
      chromeInk: s.chromeInk,
      chromeBox: s.chromeBox,
      chromeBoxAlpha: s.chromeBoxAlpha,
      chromeBorder: s.chromeBorder,
      chromeBorderAlpha: s.chromeBorderAlpha,
      glassIntensity: s.glassIntensity,
      hasCustomBackground: fs.existsSync(BACKGROUND_PATH),
      cjkFont: s.cjkFont,
      cjkFontName: s.cjkFontName,
      hasCjkFont: !!(s.cjkFontExt && fs.existsSync(cjkFontPath(s.cjkFontExt))),
      contextTurns: s.contextTurns,
      contextCount: history.recentContext(s.contextResetAt, s.contextTurns).length,
      autoSendEnabled: s.autoSendEnabled,
      autoSendSeconds: s.autoSendSeconds,
      fadeSeconds: s.fadeSeconds,
      lingerSeconds: s.lingerSeconds,
      inkLingerSeconds: s.inkLingerSeconds,
      inkFadeSeconds: s.inkFadeSeconds,
      penOnly: s.penOnly,
      replyFontScale: s.replyFontScale,
      replyAlign: s.replyAlign,
      toolbarPosition: s.toolbarPosition,
      confirmClearAll: s.confirmClearAll,
      confirmOnReset: s.confirmOnReset,
      brush: s.brush,
      pokeLines: s.pokeLines || null,
      fallbackLines: s.fallbackLines || null,
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
    const body = req.body || {};
    const next = { ...s };
    if (typeof body.maxTokens === 'number' && body.maxTokens > 0) next.maxTokens = Math.round(body.maxTokens);
    if (typeof body.font === 'string') next.font = body.font;
    if (typeof body.speed === 'number') next.speed = Math.max(1, Math.min(10, body.speed));
    if (typeof body.theme === 'string') next.theme = body.theme;
    if (typeof body.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.themeColor)) {
      next.themeColor = body.themeColor.toLowerCase();
    }
    if (typeof body.bgColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.bgColor)) {
      next.bgColor = body.bgColor.toLowerCase();
    }
    if (['day', 'night', 'custom'].includes(body.chromeTheme)) next.chromeTheme = body.chromeTheme;
    if (typeof body.chromeInk === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.chromeInk)) {
      next.chromeInk = body.chromeInk.toLowerCase();
    }
    if (typeof body.chromeBox === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.chromeBox)) {
      next.chromeBox = body.chromeBox.toLowerCase();
    }
    if (typeof body.chromeBoxAlpha === 'number' && body.chromeBoxAlpha > 0) {
      // 下限跟设置页那个滑块的 min 保持一致，不然滑到底的值一保存就被顶回来
      next.chromeBoxAlpha = Math.max(0.05, Math.min(1, body.chromeBoxAlpha));
    }
    if (typeof body.chromeBorder === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.chromeBorder)) {
      next.chromeBorder = body.chromeBorder.toLowerCase();
    }
    if (typeof body.chromeBorderAlpha === 'number' && body.chromeBorderAlpha > 0) {
      next.chromeBorderAlpha = Math.max(0.05, Math.min(1, body.chromeBorderAlpha));
    }
    if (['off', 'standard', 'enhanced'].includes(body.glassIntensity)) next.glassIntensity = body.glassIntensity;
    if (['default', 'liujian', 'zhimang', 'notoserif', 'chunfeng', 'custom'].includes(body.cjkFont)) next.cjkFont = body.cjkFont;
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
    if (typeof body.replyFontScale === 'number' && body.replyFontScale > 0) {
      next.replyFontScale = Math.max(0.5, Math.min(1.5, body.replyFontScale));
    }
    if (['left', 'center', 'right'].includes(body.replyAlign)) next.replyAlign = body.replyAlign;
    if (['left', 'bottom'].includes(body.toolbarPosition)) next.toolbarPosition = body.toolbarPosition;
    if (typeof body.confirmClearAll === 'boolean') next.confirmClearAll = body.confirmClearAll;
    if (typeof body.confirmOnReset === 'boolean') next.confirmOnReset = body.confirmOnReset;
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
      spec: providers.SPECS[body.spec] ? body.spec : 'auto',
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
    if (body.spec === 'auto' || providers.SPECS[body.spec]) p.spec = body.spec;
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
    }

    const TASK = [
      '下面这件事跟平时的对话无关，请照你上面的人设完成它。你要写两组短句，都是你自己会说的话。',
      '',
      '【第一组：被反复戳时的反应】',
      '对方会反复戳你的头像，就像戳一个人的肩膀。第一下和第七下，任何人的反应都不会一样。',
      '写五档，一档比一档情绪更重，每档三条备选（随机抽一条显示）。',
      '第一档几乎没什么反应，第五档已经拿对方没办法了。',
      '',
      '【第二组：三种意外情况下的托辞】',
      '这个应用里，对方手写一页纸给你，你读完手写回复。偶尔会出岔子，这时要由你开口说一句。',
      '三种情况各写三条备选：',
      '- unreadable：这一页你没能读出来。（对方的字迹、或者别的什么原因，按你的性格挑一个说法）',
      '- distracted：等太久了，这一轮算是错过了。',
      '- blank：话到嘴边什么都没有，得请对方再写一遍。',
      '',
      '【共同要求】',
      '- 每条都很短，最多十几个字，是脱口而出的一句，不是完整对白。',
      '- 用第一人称，就是你在说话；不要描写动作，不要加引号、编号或任何前缀。',
      '- 第二组三种都要能让对方明白"这次没成，可以再来一次"，别只顾着有情绪。',
      '- 只输出一个 JSON 对象，不要解释，不要代码块标记。',
      '',
      '格式（内容全部换成你自己的）：',
      '{"poke":[["嗯？","在。","怎么了"],["又戳。","还在。","有事？"],["…","你很闲。","别戳了。"],'
        + '["……","随你吧。","我不动了。"],["你赢了。","我认输。","随便你戳。"]],'
        + '"unreadable":["墨迹晕开了，我读不出来。","这页我认不全。","字太赶了，我跟不上。"],'
        + '"distracted":["我走神了，能再说一遍吗？","刚才没接住，再来一次。","这一轮我错过了。"],'
        + '"blank":["风把字吹散了，再写一遍吧。","我这儿是空的，你再来一次。","什么都没剩下，重来。"]}',
    ].join('\n');

    const request = {
      stream: false,
      maxTokens: 800,
      instructions: settingsStore.buildInstructions(s),
      turns: [{ role: 'user', parts: [{ type: 'text', text: TASK }] }],
    };

    let data;
    try {
      // 不重试：这是彩蛋，失败了再按一次就行，不值得替用户多花几次调用
      const upstream = await postUpstream(profile, request, { maxRetries: 1 });
      data = await upstream.json();
    } catch (e) {
      return sendUpstreamError(res, e);
    }

    const parsed = parseAttuneResult(providers.extractText(profile, data));
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
      turns: [...buildContextTurns(contextEntries), {
        role: 'user',
        parts: [
          { type: 'text', text: INSTRUCTION },
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
    const TYPED_MODE_NOTE = '（提示：这一次对方是直接打字发给你的，不是手写照片，正常回应文字内容即可，不要说"看不清"、"字迹模糊"之类只适用于图片的话。）';

    const request = {
      stream: true,
      maxTokens: parseInt(s.maxTokens, 10) || 280,
      instructions: settingsStore.buildInstructions(s) + '\n\n' + TYPED_MODE_NOTE,
      turns: [...buildContextTurns(contextEntries), { role: 'user', parts: [{ type: 'text', text }] }],
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 把一条历史记录摊成中立请求里的一轮（用户那半 + AI回复那半）。
// 手写来的那半是图，打字来的那半是文字。
function buildContextTurns(entries) {
  return entries.flatMap((entry) => [
    {
      role: 'user',
      parts: entry.kind === 'typed'
        ? [{ type: 'text', text: entry.userText || '' }]
        : [{ type: 'image', dataUrl: entry.imageDataUrl }],
    },
    { role: 'assistant', parts: [{ type: 'text', text: entry.reply }] },
  ]);
}

// 这几个状态码是"再试一次说不定就过了"：中转站对图片请求会高频 403，
// 429/500 也常常是一阵子的事。别的错（401 密钥不对、404 模型不存在）重试没意义。
const RETRY_STATUS = new Set([403, 429, 500]);

// 往上游发一次请求，带退避重试。成功返回 fetch 的 Response，失败抛出带 status/detail 的错误。
async function postUpstream(profile, request, { maxRetries = 8 } = {}) {
  const { url, headers, body } = providers.buildRequest(profile, request);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let upstream;
    try {
      upstream = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      console.error(`第${attempt}次连接失败:`, err.message);
      if (attempt === maxRetries) throw upstreamError('无法连接模型服务', 502, err.message);
      await sleep(300 * attempt);
      continue;
    }
    if (upstream.ok && (!request.stream || upstream.body)) return upstream;

    const detail = await upstream.text().catch(() => '');
    if (RETRY_STATUS.has(upstream.status) && attempt < maxRetries) {
      console.error(`第${attempt}次上游 ${upstream.status}，${attempt}s 后重试`);
      await sleep(1000 * attempt);
      continue;
    }
    console.error(`上游 ${upstream.status}:`, detail.slice(0, 300));
    throw upstreamError('模型服务返回错误', upstream.status, detail);
  }
  throw upstreamError('多次重试后仍无法获取模型响应', 502);
}

function upstreamError(message, status, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
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

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let tokenCount = 0;
  let fullText = '';
  const startedAt = Date.now();

  const finish = () => {
    res.write('data: [DONE]\n\n');
    console.log(`✓ 完成 ${tokenCount} token，用时 ${Date.now() - startedAt}ms`);
    onFinish(fullText);
    res.end();
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
        const result = providers.parseDelta(profile, eventBlock);
        if (result === DONE) return finish();
        if (result) {
          tokenCount++;
          fullText += result;
          res.write(`data: ${JSON.stringify(result)}\n\n`);
        }
      }
    }
    // Gemini 不发结束事件，流断了就是完了
    finish();
  } catch (err) {
    console.error('转发中断:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '转发中断', detail: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch {}
    }
  }
}

const SUMMARY_PROMPT = '请把以上这些互动内容总结成一段简短的长期记忆备注，帮助你以后回忆起对方是谁、聊过什么、有什么值得记住的事或偏好。控制在150字以内，不分点、不用markdown，就写成一段随手记的备注。';

// 让AI把最近几轮对话总结成一段话，用于生成"长期记忆"卡片。复用 /interpret 同款的
// 流式请求 + 重试逻辑，只是这里在服务端把整段流吃完再一次性返回文本，不转发给前端。
async function requestSummary(profile, contextEntries) {
  const request = {
    stream: true,
    maxTokens: 300,
    turns: [
      ...buildContextTurns(contextEntries),
      { role: 'user', parts: [{ type: 'text', text: SUMMARY_PROMPT }] },
    ],
  };
  const upstream = await postUpstream(profile, request, { maxRetries: 4 });

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
      const result = providers.parseDelta(profile, block);
      if (result === DONE) return fullText;
      if (result) fullText += result;
    }
  }
  return fullText;
}

const FALLBACK_KINDS = ['unreadable', 'distracted', 'blank'];

// 一句一句地洗：去掉模型爱加的引号、编号、项目符号，过长的截断。
function cleanLines(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim()
      .replace(/^[-*\d.、)\s]+/, '')
      .replace(/^["“”'']+|["“”'']+$/g, '')
      .slice(0, 40))
    .filter(Boolean);
  return out.length ? out : null;
}

// 把模型吐出来的东西解析成 { poke, fallback }。模型很爱多说两句、裹一层代码块，
// 所以先把第一个 { 到最后一个 } 之间截出来再解析。
// 也兼容早期那版只返回一个裸数组（纯五档）的形状——那会儿提示词就是那么写的。
function parseAttuneResult(text) {
  const raw = String(text || '');
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  let parsed = null;
  if (objStart >= 0 && objEnd > objStart) {
    try { parsed = JSON.parse(raw.slice(objStart, objEnd + 1)); } catch { parsed = null; }
  }
  if (!parsed) {
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart < 0 || arrEnd <= arrStart) return null;
    try { parsed = { poke: JSON.parse(raw.slice(arrStart, arrEnd + 1)) }; } catch { return null; }
  }

  // 五档：必须齐齐整整五档、每档至少一条，差一点就整个不要——递进缺一环就垮了
  let poke = null;
  if (Array.isArray(parsed.poke) && parsed.poke.length === 5) {
    const tiers = parsed.poke.map(cleanLines);
    if (tiers.every(Boolean)) poke = tiers;
  }

  // 三种托辞彼此独立，谁能用收谁，剩下的继续用内置那份
  const fallback = {};
  for (const kind of FALLBACK_KINDS) {
    const lines = cleanLines(parsed[kind]);
    if (lines) fallback[kind] = lines;
  }

  if (!poke && !Object.keys(fallback).length) return null;
  return { poke, fallback: Object.keys(fallback).length ? fallback : null };
}

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
