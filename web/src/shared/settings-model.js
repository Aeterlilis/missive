// 设置这份数据本身的规矩：默认长什么样、老格式怎么升级、人设怎么拼、首屏提示语怎么抽。
// 后端和手机版共用同一份——手机上没有后端，同样这些事得在浏览器里做，逻辑必须一模一样，
// 不然两边存出来的设置对不上。
//
// 这个文件不管"存在哪"：读写磁盘/IndexedDB 各归各的（server/settings.js、web/src/store.js），
// 进来出去的都是普通对象。所以也不许碰 fs/Buffer/process。
//
// 历次格式变更：
//  v2：支持多套 API 配置（"配置槽位"）。
//  v3：人设从单个字符串变成"提示词卡片"系统——分 ai_persona/user_persona/long_term_memory/other
//      四类，每类下能建好几张卡片，每张能单独开关，最终发给AI的是所有开着的卡片内容拼起来。
//  v4：首屏提示语也搬进卡片系统，多加一个 hint 类别——但这类卡片不参与拼AI提示词
//      （CARD_CATEGORIES 不含它），而是每天从"开着的"卡片里随机选一条展示，见 resolveHintText。
//  v5：配置槽位多一个 spec 字段（接口规范：auto/responses/chat/anthropic/gemini），
//      见 ./providers.js。存量配置一律写死成 responses——它们都是按那个接口配好能用的。

import { DEFAULT_PERSONA } from './persona.js';
import { SPECS, resolveSpec } from './providers.js';

export const CARD_CATEGORIES = ['ai_persona', 'user_persona', 'long_term_memory', 'other']; // 会拼进发给AI的instructions
export const HINT_CATEGORY = 'hint'; // 首屏提示语卡片，独立于上面——不拼AI提示词，每天随机选一条展示
export const ALL_CARD_CATEGORIES = [...CARD_CATEGORIES, HINT_CATEGORY]; // 建卡片时校验类别用这个（更全）
export const DEFAULT_HINT_TEXT = '用笔在这里写点什么…\n比如：今天发生了什么';

// 随机 id。浏览器和 Node 都有 crypto.getRandomValues，用它就不用分两套写法。
function randomId(bytes = 6) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newProfile(overrides = {}) {
  return {
    id: randomId(),
    name: '默认配置',
    baseUrl: '',
    apiKey: '',
    model: '',
    spec: 'auto', // 接口规范；auto 表示按 baseUrl 现场猜，见 ./providers.js
    ...overrides,
  };
}

export function newCard(overrides = {}) {
  return {
    id: randomId(),
    category: 'other',
    title: '新卡片',
    content: '',
    enabled: true,
    ...overrides,
  };
}

export function defaults() {
  const p = newProfile();
  return {
    profiles: [p],
    activeProfileId: p.id,
    maxTokens: 280,
    // DEFAULT_PERSONA 说的是书写环境和回应规则，不是角色扮演意义上的"人设"，归到系统提示词类别；
    // 首屏提示语也预置一张默认卡片，跟系统提示词一个待遇，不然刚装完打开设置页"提示语列表"是空的
    promptCards: [
      newCard({ category: 'other', title: '环境与回应规则', content: DEFAULT_PERSONA, enabled: true }),
      newCard({ category: HINT_CATEGORY, title: '默认提示语', content: DEFAULT_HINT_TEXT, enabled: true }),
    ],
    font: 'pinyon', // pinyon(花体) | medieval(哥特体) | wenkai(统一用文楷) | manufacturing(油墨印章体) | monsieur(华丽花体) | mysoul(俏皮手写体)
    speed: 6,       // 1(慢) ~ 10(快)
    hintText: DEFAULT_HINT_TEXT, // 旧版遗留字段：迁移到 hint 卡片后只在"一张卡片都没有"时当兜底用，见 resolveHintText
    hintPickDate: null,   // 上次抽首屏提示语的日期（本机 YYYY-MM-DD），换了新的一天才重新抽
    hintPickCardId: null, // 当天抽中的那张 hint 卡片 id
    // 戳写字页那个图标时换出来的话：五档递进，每档一小撮备选。
    // null = 还没让 AI 按人设生成过，前端用自己内置的兜底那套（见 web/src/pokelines.js）。
    // 故意不在设置页里列成可编辑项——这是彩蛋。
    pokeLines: null,
    // 出岔子时替 AI 说的那句话：{ unreadable, distracted, blank } 三种各一组备选。
    // 同样由「磨合」生成，null / 缺哪种就用前端内置的那份（见 web/src/pokelines.js）。
    fallbackLines: null,
    theme: 'solid', // solid(纯色，配 bgColor) | parchment | lined | grid | xuanzhi | watercolor | crumpled | black | custom
    themeColor: '#000000', // 开关/滑块这些控件的统一主题色
    bgColor: '#ffffff', // 纸张背景选"纯色"（theme:'solid'）时用的颜色
    chromeTheme: 'day', // day(白天) | night(夜间) | custom(自定义，用下面三个值)
    chromeInk: '#000000',   // 界面配色：所有框框的文字/边框颜色
    chromeBox: '#ffffff',   // 界面配色：所有框框的底色
    chromeBoxAlpha: 0.55,   // 界面配色：底色透明度
    chromeBorder: '#000000',   // 界面配色：边框颜色，跟文字颜色分开算
    chromeBorderAlpha: 1,       // 界面配色：边框透明度
    glassIntensity: 'standard', // off(不用玻璃，只剩底色和边框) | standard(标准毛玻璃) | enhanced(更透亮：反光+两侧边缘光+支持的话有边缘倒影，见 web/src/glass.js)
    cjkFont: 'default', // default(霞鹜文楷) | liujian(草书连笔) | zhimang(行书体) | notoserif(宋体) | chunfeng(春风楷书) | custom(自己传的字体)
    cjkFontExt: null,    // 存的自定义字体文件后缀（ttf/otf/ttc），没传过就是 null
    cjkFontName: '',     // 自定义字体的原始文件名，UI 显示用
    contextTurns: 10,     // 滚动上下文窗口大小
    contextResetAt: null, // 重置对话时间点；null 表示从最开始算
    conversationId: 1,    // 每次"重置对话"就+1，历史记录页按这个把条目分组成一次次对话
    autoSendEnabled: true,
    autoSendSeconds: 2.8, // 停笔多久后自动发送（仅 autoSendEnabled 时生效）
    fadeSeconds: 1.5,     // AI回复淡出的时长
    penOnly: false,       // 防误触：只认笔，忽略手指/手掌触摸
    replyAlign: 'center',    // 纸上文字的水平对齐：left | center | right（AI回复和打字内容共用）
    replyFontScale: 1,       // 回复字号的缩放系数，1=按屏宽自适应算出来的原始大小（见 web/src/config.js 的 layout）
    toolbarPosition: 'left', // 写字页工具栏摆哪：left(左上竖排，绘画软件那种) | bottom(底部居中，够得着拇指)
    confirmClearAll: true,   // 一键清空笔迹前弹一下确认。默认开——清空不可逆，误触一次就全没了
    confirmOnReset: true,    // 点重置对话时弹框问要不要先总结成长期记忆。关掉就直接重置、不总结——
                             // 总结要花一次 API 调用还得等，不该在没问过的情况下发生
    brush: {
      preset: 'pen',      // pen | ballpoint | marker | brush | flat | pointed
      size: 7,
      color: '#000000',
      // 每支笔各自被调过的粗细/笔尖角度，形如 { flat: { size: 16, nibAngleDeg: 30 } }。
      // 没调过的笔不在这里，取预设自带的默认值（见 web/src/config.js 的 BRUSH_PRESETS）。
      // 顶层的 size 是"当前这支笔"的，留着给旧版本读。
      byPreset: {},
    },
  };
}

// 兼容老的单配置格式（baseUrl/apiKey/model 直接在顶层）：升级成 profiles 数组
function migrateFlatToProfiles(raw) {
  if (Array.isArray(raw.profiles) && raw.profiles.length > 0) return raw;
  const p = newProfile({
    baseUrl: raw.baseUrl || '',
    apiKey: raw.apiKey || '',
    model: raw.model || '',
    spec: 'responses', // 单配置那个年代只有 Responses 一种接口
  });
  const next = { ...raw };
  delete next.baseUrl;
  delete next.apiKey;
  delete next.model;
  next.profiles = [p];
  next.activeProfileId = p.id;
  return next;
}

// 兼容老的单个 persona 字符串：升级成一张卡片。真是用户自己写的人设就归 ai_persona，
// 没设置过、落到 DEFAULT_PERSONA 兜底的，跟新默认值一样归到系统提示词类别
function migratePersonaToCards(raw) {
  if (Array.isArray(raw.promptCards)) return raw;
  const next = { ...raw };
  const hasCustomPersona = typeof raw.persona === 'string' && raw.persona.trim();
  const content = hasCustomPersona ? raw.persona : DEFAULT_PERSONA;
  const category = hasCustomPersona ? 'ai_persona' : 'other';
  const title = hasCustomPersona ? '默认人设' : '环境与回应规则';
  next.promptCards = [newCard({ category, title, content, enabled: true })];
  delete next.persona;
  return next;
}

// 兼容 v3 存量数据：promptCards 已经存在，但还没有 hint 类别的卡片——
// 把老的单条 hintText 迁进来当第一张卡（没自定义过的话就用默认文案）
function migrateHintToCard(raw) {
  if (!Array.isArray(raw.promptCards)) return raw; // 还没到"有 promptCards"这一步，交给上面的迁移先跑
  if (raw.promptCards.some((c) => c.category === HINT_CATEGORY)) return raw;
  const next = { ...raw };
  const hasCustomHint = typeof raw.hintText === 'string' && raw.hintText.trim() && raw.hintText !== DEFAULT_HINT_TEXT;
  const content = hasCustomHint ? raw.hintText : DEFAULT_HINT_TEXT;
  next.promptCards = [...raw.promptCards, newCard({ category: HINT_CATEGORY, title: '默认提示语', content, enabled: true })];
  return next;
}

// 兼容 v4 之前的配置槽位：那时候还没有 spec 字段。存量配置全是照 Responses 接口填的，
// 明确写成 'responses' 而不是留给自动识别——升级不该把本来能用的配置改坏。
function migrateProfileSpec(raw) {
  if (!Array.isArray(raw.profiles)) return raw; // 还是老的扁平格式，交给上面的迁移先跑
  if (raw.profiles.every((p) => typeof p.spec === 'string')) return raw;
  return {
    ...raw,
    profiles: raw.profiles.map((p) => (typeof p.spec === 'string' ? p : { ...p, spec: 'responses' })),
  };
}

// 把存下来的原始设置升级到当前格式并补齐缺省字段，返回 { settings, changed }。
// changed 为真表示格式确实动过，调用方该把结果落盘一次，免得每次读取都重新迁移一遍。
//
// 迁移顺序很重要：先在原始数据上做迁移拿到真实内容，再补齐缺省字段——
// 一旦先套上默认值里的空数组，旧的顶层字段就会被当成"已经有了"而被忽略。
export function upgrade(raw) {
  const wasFlat = !Array.isArray(raw.profiles);
  const wasFlatPersona = !Array.isArray(raw.promptCards);
  const wasMissingSpec = wasFlat || raw.profiles.some((p) => typeof p.spec !== 'string');
  let next = migrateFlatToProfiles(raw);
  next = migratePersonaToCards(next);
  const wasMissingHintCard = !next.promptCards.some((c) => c.category === HINT_CATEGORY);
  next = migrateHintToCard(next);
  next = migrateProfileSpec(next);
  const merged = { ...defaults(), ...next };
  if (!merged.profiles.some((p) => p.id === merged.activeProfileId)) {
    merged.activeProfileId = merged.profiles[0].id;
  }
  return {
    settings: merged,
    changed: wasFlat || wasFlatPersona || wasMissingHintCard || wasMissingSpec,
  };
}

export function activeProfile(settings) {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0] || newProfile();
}

// 把所有"开着"的卡片内容按 类别顺序 拼成最终发给AI的 instructions
export function buildInstructions(settings) {
  const parts = [];
  for (const cat of CARD_CATEGORIES) {
    for (const c of settings.promptCards) {
      if (c.category === cat && c.enabled && c.content && c.content.trim()) {
        parts.push(c.content.trim());
      }
    }
  }
  return parts.join('\n\n') || DEFAULT_PERSONA;
}

function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 首屏提示语：从开着的 hint 卡片里每天随机选一条，同一天内保持不变（选中的卡片id记进
// settings，不是纯算出来的，避免同一天内每次刷新设置页都重新抽一次）。一张都没开的话
// 退回旧版遗留的 hintText 兜底。
//
// 返回 { text, changed }：抽了新的一条时 changed 为真，settings 已被就地改过，
// 调用方负责落盘——这个文件不管存在哪。
export function resolveHintText(settings) {
  const enabled = settings.promptCards.filter(
    (c) => c.category === HINT_CATEGORY && c.enabled && c.content && c.content.trim()
  );
  if (enabled.length === 0) return { text: settings.hintText || DEFAULT_HINT_TEXT, changed: false };
  const today = todayLocalDate();
  if (settings.hintPickDate === today) {
    const kept = enabled.find((c) => c.id === settings.hintPickCardId);
    if (kept) return { text: kept.content, changed: false };
  }
  const picked = enabled[Math.floor(Math.random() * enabled.length)];
  settings.hintPickDate = today;
  settings.hintPickCardId = picked.id;
  return { text: picked.content, changed: true };
}

// ─── 对外投影 ─────────────────────────────────────
// 页面拿到的设置跟存下来的不完全一样：**apiKey 永远不给出去**，只给一个"填没填过"。
// 后端时代这是为了不把密钥发到网线上；本地模式下页面和存储在同一个进程里，这层依然留着——
// 密钥只在真正发请求的那一刻取用，别的地方碰不到它，能少一整类"不小心显示/打印出来"的事故。

// resolvedSpec 是"选自动识别时，现在这个 URL 会被判成哪种"，给设置页显示用
export function publicProfile(p) {
  return {
    id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, hasKey: !!p.apiKey,
    spec: p.spec || 'auto', resolvedSpec: resolveSpec(p),
  };
}

// extras 里那几个是"存储那边才知道的事"（有没有存过背景图/字体、上下文攒了几条），
// 各自的存储实现算好了传进来。
export function publicSettings(s, extras = {}) {
  return {
    profiles: s.profiles.map(publicProfile),
    activeProfileId: s.activeProfileId,
    maxTokens: s.maxTokens,
    promptCards: s.promptCards,
    font: s.font,
    speed: s.speed,
    hintText: extras.hintText,
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
    hasCustomBackground: !!extras.hasCustomBackground,
    cjkFont: s.cjkFont,
    cjkFontName: s.cjkFontName,
    hasCjkFont: !!extras.hasCjkFont,
    contextTurns: s.contextTurns,
    contextCount: extras.contextCount || 0,
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
  };
}

// ─── 保存设置 ─────────────────────────────────────
// 逐项校验再落，认识的才收：页面传来的值不一定干净（老版本页面、手改过的存档、
// 将来某个还没做完的控件），照单全收会把设置写成一堆 undefined。
// 返回新的设置对象，原来那个不动。

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function applySettingsPatch(settings, patch = {}) {
  const s = settings;
  const body = patch;
  const next = { ...s };
  const hex = (v) => typeof v === 'string' && HEX6.test(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  if (typeof body.maxTokens === 'number' && body.maxTokens > 0) next.maxTokens = Math.round(body.maxTokens);
  if (typeof body.font === 'string') next.font = body.font;
  if (typeof body.speed === 'number') next.speed = clamp(body.speed, 1, 10);
  if (typeof body.theme === 'string') next.theme = body.theme;
  if (hex(body.themeColor)) next.themeColor = body.themeColor.toLowerCase();
  if (hex(body.bgColor)) next.bgColor = body.bgColor.toLowerCase();
  if (['day', 'night', 'custom'].includes(body.chromeTheme)) next.chromeTheme = body.chromeTheme;
  if (hex(body.chromeInk)) next.chromeInk = body.chromeInk.toLowerCase();
  if (hex(body.chromeBox)) next.chromeBox = body.chromeBox.toLowerCase();
  if (typeof body.chromeBoxAlpha === 'number' && body.chromeBoxAlpha > 0) {
    // 下限跟设置页那个滑块的 min 保持一致，不然滑到底的值一保存就被顶回来
    next.chromeBoxAlpha = clamp(body.chromeBoxAlpha, 0.05, 1);
  }
  if (hex(body.chromeBorder)) next.chromeBorder = body.chromeBorder.toLowerCase();
  if (typeof body.chromeBorderAlpha === 'number' && body.chromeBorderAlpha > 0) {
    next.chromeBorderAlpha = clamp(body.chromeBorderAlpha, 0.05, 1);
  }
  if (['off', 'standard', 'enhanced'].includes(body.glassIntensity)) next.glassIntensity = body.glassIntensity;
  if (['default', 'liujian', 'zhimang', 'notoserif', 'chunfeng', 'custom'].includes(body.cjkFont)) next.cjkFont = body.cjkFont;
  if (typeof body.autoSendEnabled === 'boolean') next.autoSendEnabled = body.autoSendEnabled;
  if (typeof body.autoSendSeconds === 'number' && body.autoSendSeconds > 0) next.autoSendSeconds = clamp(body.autoSendSeconds, 0.5, 20);
  if (typeof body.fadeSeconds === 'number' && body.fadeSeconds > 0) next.fadeSeconds = clamp(body.fadeSeconds, 0.3, 8);
  if (typeof body.lingerSeconds === 'number' && body.lingerSeconds > 0) next.lingerSeconds = clamp(body.lingerSeconds, 1, 15);
  if (typeof body.inkLingerSeconds === 'number' && body.inkLingerSeconds > 0) next.inkLingerSeconds = clamp(body.inkLingerSeconds, 0.5, 10);
  if (typeof body.inkFadeSeconds === 'number' && body.inkFadeSeconds > 0) next.inkFadeSeconds = clamp(body.inkFadeSeconds, 0.3, 6);
  if (typeof body.penOnly === 'boolean') next.penOnly = body.penOnly;
  if (typeof body.replyFontScale === 'number' && body.replyFontScale > 0) next.replyFontScale = clamp(body.replyFontScale, 0.5, 1.5);
  if (['left', 'center', 'right'].includes(body.replyAlign)) next.replyAlign = body.replyAlign;
  if (['left', 'bottom'].includes(body.toolbarPosition)) next.toolbarPosition = body.toolbarPosition;
  if (typeof body.confirmClearAll === 'boolean') next.confirmClearAll = body.confirmClearAll;
  if (typeof body.confirmOnReset === 'boolean') next.confirmOnReset = body.confirmOnReset;
  if (body.brush && typeof body.brush === 'object') next.brush = { ...s.brush, ...body.brush };
  if (typeof body.activeProfileId === 'string' && s.profiles.some((p) => p.id === body.activeProfileId)) {
    next.activeProfileId = body.activeProfileId;
  }
  return next;
}

// 新建配置槽位时同样只收认识的字段
export function profileFromInput(body = {}) {
  return newProfile({
    name: (body.name || '新配置').trim(),
    baseUrl: (body.baseUrl || '').trim(),
    apiKey: (body.apiKey || '').trim(),
    model: (body.model || '').trim(),
    spec: SPECS[body.spec] ? body.spec : 'auto',
  });
}

// 改配置槽位：就地改，只动传了的字段。
// **密钥留空表示"不改"**，不是"清空"——页面为了不显示密钥，那个输入框平时就是空的，
// 收到空值当清空的话，改个模型名就会把密钥抹掉。
export function applyProfilePatch(p, body = {}) {
  if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
  if (typeof body.baseUrl === 'string') p.baseUrl = body.baseUrl.trim();
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) p.apiKey = body.apiKey.trim();
  if (typeof body.model === 'string') p.model = body.model.trim();
  if (body.spec === 'auto' || SPECS[body.spec]) p.spec = body.spec;
  return p;
}

// 改提示词卡片：标题空着就保持原样（免得手滑清空标题之后一张卡认不出是哪张）
export function applyCardPatch(card, body = {}) {
  if (typeof body.title === 'string') card.title = body.title.trim() || card.title;
  if (typeof body.content === 'string') card.content = body.content;
  if (typeof body.enabled === 'boolean') card.enabled = body.enabled;
  return card;
}

// 生成/更新"长期记忆"类下的卡片——固定只维护这一张，重复总结会覆盖上一次的内容
export function upsertLongTermMemoryCard(settings, content) {
  let card = settings.promptCards.find((c) => c.category === 'long_term_memory');
  const title = '长期记忆 · ' + new Date().toISOString().slice(0, 10);
  if (card) {
    card.content = content;
    card.enabled = true;
    card.title = title;
  } else {
    card = newCard({ category: 'long_term_memory', title, content, enabled: true });
    settings.promptCards.push(card);
  }
  return card;
}
