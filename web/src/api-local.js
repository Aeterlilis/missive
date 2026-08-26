// 全在浏览器里干的实现：设置和历史存 IndexedDB（见 ./store.js），AI 请求从页面直接发。
// 手机版走的是这套，桌面版将来也会。方法清单和约定见 ./api.js。
//
// 业务规则一条都没在这儿重写——校验、迁移、提示词、接口翻译、重试拆流全在 ./shared/ 里，
// 跟后端是同一份代码。这个文件只做两件事：把那些规则接到本地存储上，把结果包成
// 页面认得的形状。

import { ApiError } from './api-error.js';
import * as store from './store.js';
import { KEYS } from './store.js';
import * as model from './shared/settings-model.js';
import * as convo from './shared/conversation.js';
import { INSTRUCTION } from './shared/persona.js';
import { postUpstream, readTokens, readAllText } from './shared/upstream.js';
import { SPECS, listModels as listUpstreamModels } from './shared/providers.js';

// ─── 设置的读写 ───────────────────────────────────
// 存的是完整设置（含密钥）；给页面的是 publicSettings 投影过的那份。

let cached = null;

async function loadSettings() {
  if (cached) return cached;
  const raw = await store.getKv(KEYS.settings);
  const { settings, changed } = model.upgrade(raw || {});
  if (changed || !raw) await store.setKv(KEYS.settings, settings); // 头一回或格式升过级，落一次
  cached = settings;
  return cached;
}

async function persist(settings) {
  cached = settings;
  await store.setKv(KEYS.settings, settings);
  return settings;
}

// 页面要的那几个"存储那边才知道的事"
async function publicExtras(s) {
  const [bg, font, recent] = await Promise.all([
    store.getKv(KEYS.background),
    store.getKv(KEYS.cjkFont),
    store.historyRecent(s.contextResetAt, s.contextTurns || 10),
  ]);
  // 首屏提示语抽中新的一条要落盘，不然同一天内每次刷新都会重抽
  const hint = model.resolveHintText(s);
  if (hint.changed) await persist(s);
  return {
    hintText: hint.text,
    hasCustomBackground: !!bg,
    hasCjkFont: !!(font && font.blob),
    contextCount: recent.length,
  };
}

// ─── 图片/字体：存 Blob，取的时候现给一个 blob: 地址 ──
// 每次都要把上一个地址收回来。blob: 地址是浏览器替你攥着那份数据的凭据，只要不主动
// 撤销，那份数据在整个页面生命周期里都不会被回收——反复换背景图就会一路涨内存。

const objectUrls = {};

function freshObjectUrl(key, blob) {
  if (objectUrls[key]) URL.revokeObjectURL(objectUrls[key]);
  objectUrls[key] = URL.createObjectURL(blob);
  return objectUrls[key];
}

// data:...;base64,xxx → Blob。走 fetch 比 atob 再逐字符转数组快得多，
// 中文字体动辄 20MB+，那种写法会卡住一两秒。
const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then((r) => r.blob());

// ─── AI 请求 ─────────────────────────────────────

// 页面那边（capture.js）按 Response 的形状用返回值：读 .ok / .status / .text() / .body。
// 本地模式没有真的 HTTP 往返，就现造一个 Response——这样 capture.js 和 oracle.js
// 一个字都不用改，两种模式的差别到这里为止。
const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

// 把一段段文本包成本应用自己那套 SSE（每行 data: {token}，结束时 data: [DONE]）。
// onFinish 拿到这一轮的完整文本，用来落历史。
function sseResponse(tokens, onFinish) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let full = '';
      try {
        for await (const piece of tokens) {
          full += piece;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(piece)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        await onFinish(full);
      } catch (err) {
        // 流已经开始了，没法再改状态码，只能把错情塞进流里——oracle.js 认得这个形状
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// 手写和打字两条路只有"这一轮发什么"和"历史里记什么"不同，其余完全一样
async function interpret({ imageDataUrl, text }) {
  const s = await loadSettings();
  const profile = model.activeProfile(s);
  if (!profile.apiKey || !profile.baseUrl || !profile.model) {
    return jsonResponse(400, { error: '还没配置 API，请先点右上角的设置图标填一下' });
  }

  // 滚动上下文：把最近几轮（用户写的图/打的字 + AI当时的回复）一起发过去，AI才能接得上话。
  // 用户手动"重置对话"之后，重置点之前的历史就不会再被算进去了。
  const contextEntries = await store.historyRecent(s.contextResetAt, s.contextTurns || 10);
  const typed = typeof text === 'string';

  const request = {
    stream: true,
    maxTokens: parseInt(s.maxTokens, 10) || 280,
    instructions: model.buildInstructions(s) + (typed ? '\n\n' + convo.TYPED_MODE_NOTE : ''),
    turns: [...convo.buildContextTurns(contextEntries), {
      role: 'user',
      parts: typed
        ? [{ type: 'text', text }]
        : [{ type: 'text', text: INSTRUCTION }, { type: 'image', dataUrl: imageDataUrl }],
    }],
  };

  let upstream;
  try {
    upstream = await postUpstream(profile, request);
  } catch (e) {
    return jsonResponse(e.status || 502, { error: e.message, detail: e.detail });
  }

  const conversationId = s.conversationId || 1;
  return sseResponse(readTokens(upstream, profile), async (fullText) => {
    if (!fullText.trim()) return;
    await store.historyAppend(typed
      ? { kind: 'typed', userText: text, reply: fullText, conversationId }
      : { kind: 'ink', imageDataUrl, reply: fullText, conversationId });
  });
}

// 手写那条路收到的是 PNG Blob，得先转成 data URL——请求里图片就是这么带的
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('读取图片失败'));
    fr.readAsDataURL(blob);
  });
}

export const local = {
  async getSettings() {
    const s = await loadSettings();
    return model.publicSettings(s, await publicExtras(s));
  },

  async saveSettings(patch) {
    const s = await loadSettings();
    await persist(model.applySettingsPatch(s, patch));
    return { ok: true };
  },

  // 重置对话：之后的请求不再把重置点之前的历史当上下文（历史本身不删）。
  // summarize 为真的话，重置前先让 AI 把最近这段总结成一张"长期记忆"卡片。
  async resetContext({ summarize } = {}) {
    const s = await loadSettings();
    let memoryCard = null;

    if (summarize) {
      const profile = model.activeProfile(s);
      if (!profile.apiKey || !profile.baseUrl || !profile.model) {
        throw new ApiError('还没配置 API，没法总结', 400);
      }
      const entries = await store.historyRecent(s.contextResetAt, s.contextTurns || 10);
      if (entries.length === 0) throw new ApiError('目前还没有可以总结的对话内容', 400);
      try {
        const upstream = await postUpstream(profile, {
          stream: true,
          maxTokens: 300,
          turns: [
            ...convo.buildContextTurns(entries),
            { role: 'user', parts: [{ type: 'text', text: convo.SUMMARY_PROMPT }] },
          ],
        }, { maxRetries: 4 });
        const summary = await readAllText(upstream, profile);
        memoryCard = model.upsertLongTermMemoryCard(s, summary.trim());
      } catch (e) {
        throw new ApiError('总结失败: ' + e.message, 502);
      }
    }

    s.contextResetAt = new Date().toISOString();
    s.conversationId = (s.conversationId || 1) + 1;
    await persist(s);
    return { ok: true, contextResetAt: s.contextResetAt, memoryCard };
  },

  // ─── 自定义背景图 ───────────────────────────────
  async backgroundImageUrl() {
    const blob = await store.getKv(KEYS.background);
    if (!blob) return ''; // 没存过。返回空串而不是抛错——调用方是"顺手贴个背景"，不该因此炸掉
    return freshObjectUrl('background', blob);
  },

  async saveBackground(imageDataUrl) {
    if (!/^data:image\/(?:png|jpeg|jpg);base64,/.test(String(imageDataUrl || ''))) {
      throw new ApiError('图片格式不对，得是 PNG 或 JPEG', 400);
    }
    const blob = await dataUrlToBlob(imageDataUrl);
    if (blob.size > 6 * 1024 * 1024) throw new ApiError('图片太大了（超过6MB）', 400);
    await store.setKv(KEYS.background, blob);
    return { ok: true };
  },

  // ─── 自定义中文手写字体 ─────────────────────────
  async cjkFontUrl() {
    const font = await store.getKv(KEYS.cjkFont);
    if (!font || !font.blob) return '';
    return freshObjectUrl('cjkFont', font.blob);
  },

  async saveCjkFont({ filename, fontDataBase64 }) {
    const name = String(filename || '');
    const m = /\.(ttf|otf|ttc)$/.exec(name.toLowerCase());
    if (!m) throw new ApiError('只支持 .ttf / .otf / .ttc 字体文件', 400);
    if (!fontDataBase64) throw new ApiError('没收到字体数据', 400);
    const ext = m[1];
    let blob;
    try {
      blob = await dataUrlToBlob(`data:font/${ext};base64,${fontDataBase64}`);
    } catch {
      throw new ApiError('字体数据格式不对', 400);
    }
    if (blob.size < 100) throw new ApiError('字体文件看起来是空的', 400);
    if (blob.size > 30 * 1024 * 1024) throw new ApiError('字体文件太大了（超过30MB）', 400);

    const s = await loadSettings();
    s.cjkFont = 'custom';
    s.cjkFontExt = ext;
    s.cjkFontName = name || ('自定义字体.' + ext);
    // 换字体了，上一个连同它的 blob: 地址一起扔掉，别攒垃圾
    if (objectUrls.cjkFont) { URL.revokeObjectURL(objectUrls.cjkFont); delete objectUrls.cjkFont; }
    await store.setKv(KEYS.cjkFont, { name: s.cjkFontName, ext, blob });
    await persist(s);
    return { ok: true, cjkFontName: s.cjkFontName };
  },

  async deleteCjkFont() {
    const s = await loadSettings();
    s.cjkFont = 'default';
    s.cjkFontExt = null;
    s.cjkFontName = '';
    if (objectUrls.cjkFont) { URL.revokeObjectURL(objectUrls.cjkFont); delete objectUrls.cjkFont; }
    await store.delKv(KEYS.cjkFont);
    await persist(s);
    return { ok: true };
  },

  // ─── 历史记录 ───────────────────────────────────
  // 页面要的是新的在前，存储里是按时间从早到晚，这里翻过来——跟原来后端的行为一致
  async listHistory() {
    const all = await store.historyAll();
    return all.reverse();
  },

  async deleteHistoryEntry(id) {
    await store.historyRemove(id);
    return { ok: true };
  },

  // ─── 提示词卡片 ─────────────────────────────────
  async createCard(body = {}) {
    const s = await loadSettings();
    if (!model.ALL_CARD_CATEGORIES.includes(body.category)) throw new ApiError('未知的卡片类别', 400);
    const card = model.newCard({
      category: body.category,
      title: (body.title || '新卡片').trim(),
      content: body.content || '',
      enabled: body.enabled !== false,
    });
    s.promptCards.push(card);
    await persist(s);
    return { ok: true, card };
  },

  async updateCard(id, patch) {
    const s = await loadSettings();
    const card = s.promptCards.find((c) => c.id === id);
    if (!card) throw new ApiError('卡片不存在', 404);
    model.applyCardPatch(card, patch);
    await persist(s);
    return { ok: true, card };
  },

  async deleteCard(id) {
    const s = await loadSettings();
    const idx = s.promptCards.findIndex((c) => c.id === id);
    if (idx === -1) throw new ApiError('卡片不存在', 404);
    s.promptCards.splice(idx, 1);
    await persist(s);
    return { ok: true };
  },

  // ─── 配置槽位 ───────────────────────────────────
  async createProfile(body) {
    const s = await loadSettings();
    const p = model.profileFromInput(body);
    s.profiles.push(p);
    s.activeProfileId = p.id;
    await persist(s);
    return { ok: true, profile: model.publicProfile(p) };
  },

  async updateProfile(id, patch) {
    const s = await loadSettings();
    const p = s.profiles.find((x) => x.id === id);
    if (!p) throw new ApiError('配置不存在', 404);
    model.applyProfilePatch(p, patch);
    await persist(s);
    return { ok: true, profile: model.publicProfile(p) };
  },

  async deleteProfile(id) {
    const s = await loadSettings();
    if (s.profiles.length <= 1) throw new ApiError('至少要留一个配置', 400);
    const idx = s.profiles.findIndex((x) => x.id === id);
    if (idx === -1) throw new ApiError('配置不存在', 404);
    s.profiles.splice(idx, 1);
    if (s.activeProfileId === id) s.activeProfileId = s.profiles[0].id;
    await persist(s);
    return { ok: true, activeProfileId: s.activeProfileId };
  },

  // 拉某个端点支持的模型列表。请求走的是"设置页里此刻填着的值"，还没保存也能试；
  // 密钥那栏平时是空的（页面拿不到密钥），空着就用存下来的那个。
  async listModels(body = {}) {
    const s = await loadSettings();
    let baseUrl = (body.baseUrl || '').trim();
    let apiKey = (body.apiKey || '').trim();
    if ((!baseUrl || !apiKey) && body.profileId) {
      const p = s.profiles.find((x) => x.id === body.profileId);
      if (p) {
        baseUrl = baseUrl || p.baseUrl;
        apiKey = apiKey || p.apiKey;
      }
    }
    if (!baseUrl || !apiKey) throw new ApiError('缺少 API 基础URL 或密钥', 400);
    const spec = (body.spec === 'auto' || SPECS[body.spec]) ? body.spec : 'auto';
    try {
      return { models: await listUpstreamModels({ baseUrl, apiKey, spec }) };
    } catch (e) {
      throw new ApiError(e.message, e.status || 502, e.detail);
    }
  },

  // ─── 「磨合」：让 AI 照人设把彩蛋文案写一遍 ────────
  async generatePokeLines() {
    const s = await loadSettings();
    const profile = model.activeProfile(s);
    if (!profile.apiKey || !profile.baseUrl || !profile.model) throw new ApiError('还没配置 API', 400);

    let text;
    try {
      // 不重试：这是彩蛋，失败了再按一次就行，不值得替用户多花几次调用
      const upstream = await postUpstream(profile, {
        stream: true,
        maxTokens: 800,
        instructions: model.buildInstructions(s),
        turns: [{ role: 'user', parts: [{ type: 'text', text: convo.ATTUNE_TASK }] }],
      }, { maxRetries: 1 });
      text = await readAllText(upstream, profile);
    } catch (e) {
      throw new ApiError(e.message, e.status || 502, e.detail);
    }

    const parsed = convo.parseAttuneResult(text);
    // 戳的那五档是这次的主菜，它没解析出来就整个算失败——保留原有的，绝不写半套进去。
    // 三种托辞是各自独立的，谁能用就换谁，剩下的继续用内置那份。
    if (!parsed || !parsed.poke) throw new ApiError('模型没给出可用的格式', 422);
    s.pokeLines = parsed.poke;
    if (parsed.fallback) s.fallbackLines = { ...(s.fallbackLines || {}), ...parsed.fallback };
    await persist(s);
    return { ok: true };
  },

  // ─── 写一页纸 / 打一段字 ────────────────────────
  async interpretInk(pngBlob) {
    return interpret({ imageDataUrl: await blobToDataUrl(pngBlob) });
  },

  interpretText(text) {
    return interpret({ text });
  },
};
