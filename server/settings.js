// 设置持久化。网页版(局域网)存在 server/settings.json；
// 桌面版(Electron)通过 SETTINGS_DIR 环境变量指向 userData 目录，避免装到只读路径下写不进去。
//
// v2：支持多套 API 配置("配置槽位")。
// v3：人设从单个字符串变成"提示词卡片"系统——分 ai_persona/user_persona/long_term_memory/other
//     四类，每类下能建好几张卡片，每张能单独开关，最终发给AI的是所有开着的卡片内容拼起来。
// v4：首屏提示语也搬进卡片系统，多加一个 hint 类别——但这类卡片不参与拼AI提示词（CARD_CATEGORIES
//     不含它），而是每天从"开着的"卡片里随机选一条展示，见 resolveHintText。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_PERSONA } = require('./persona');

const DIR = process.env.SETTINGS_DIR || __dirname;
const SETTINGS_PATH = path.join(DIR, 'settings.json');
const LEGACY_ENV_PATH = path.join(__dirname, '.env');

const CARD_CATEGORIES = ['ai_persona', 'user_persona', 'long_term_memory', 'other']; // 会拼进发给AI的instructions
const HINT_CATEGORY = 'hint'; // 首屏提示语卡片，独立于上面——不拼AI提示词，每天随机选一条展示
const ALL_CARD_CATEGORIES = [...CARD_CATEGORIES, HINT_CATEGORY]; // /api/cards 创建卡片时校验类别用这个（更全）
const DEFAULT_HINT_TEXT = '用笔在这里写点什么…\n比如：今天发生了什么';

function newProfile(overrides = {}) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: '默认配置',
    baseUrl: '',
    apiKey: '',
    model: '',
    ...overrides,
  };
}

function newCard(overrides = {}) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    category: 'other',
    title: '新卡片',
    content: '',
    enabled: true,
    ...overrides,
  };
}

function defaultsWithProfile() {
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
    // 故意不在设置页里列成可编辑项——这是彩蛋，见 /api/poke-lines/generate。
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
    glassIntensity: 'standard', // standard(标准毛玻璃) | enhanced(更透亮：反光+两侧边缘光+支持的话有边缘倒影，见 web/src/glass.js)
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
      preset: 'pen',      // pen | ballpoint | marker | brush
      size: 7,
      color: '#000000',
    },
  };
}

// 首次运行：如果老的 .env 里有配置，直接读过来，不用用户重填一遍
function migrateFromEnv() {
  if (!fs.existsSync(LEGACY_ENV_PATH)) return null;
  try {
    const txt = fs.readFileSync(LEGACY_ENV_PATH, 'utf-8');
    const get = (key) => {
      const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const apiKey = get('OPENAI_API_KEY');
    if (!apiKey) return null;
    const maxTokens = parseInt(get('MAX_TOKENS'), 10);
    const p = newProfile({
      baseUrl: get('OPENAI_BASE_URL'),
      apiKey,
      model: get('OPENAI_MODEL'),
    });
    return {
      ...defaultsWithProfile(),
      profiles: [p],
      activeProfileId: p.id,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 280,
    };
  } catch {
    return null;
  }
}

// 兼容老的单配置格式（baseUrl/apiKey/model 直接在顶层）：升级成 profiles 数组
function migrateFlatToProfiles(raw) {
  if (Array.isArray(raw.profiles) && raw.profiles.length > 0) return raw;
  const p = newProfile({
    baseUrl: raw.baseUrl || '',
    apiKey: raw.apiKey || '',
    model: raw.model || '',
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

function load() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      const wasFlat = !Array.isArray(raw.profiles);
      const wasFlatPersona = !Array.isArray(raw.promptCards);
      // 迁移顺序很重要：先在原始数据上做迁移拿到真实内容，再补齐缺省字段——
      // 一旦先套上默认值里的空数组，旧的顶层字段就会被当成"已经有了"而被忽略
      let upgraded = migrateFlatToProfiles(raw);
      upgraded = migratePersonaToCards(upgraded);
      const wasMissingHintCard = !upgraded.promptCards.some((c) => c.category === HINT_CATEGORY);
      upgraded = migrateHintToCard(upgraded);
      const merged = { ...defaultsWithProfile(), ...upgraded };
      if (!merged.profiles.some((p) => p.id === merged.activeProfileId)) {
        merged.activeProfileId = merged.profiles[0].id;
      }
      if (wasFlat || wasFlatPersona || wasMissingHintCard) save(merged); // 落盘一次，避免每次读取都重新迁移
      return merged;
    } catch {
      return defaultsWithProfile();
    }
  }
  const migrated = migrateFromEnv();
  const initial = migrated || defaultsWithProfile();
  save(initial);
  return initial;
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function activeProfile(settings) {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0] || newProfile();
}

// 把所有"开着"的卡片内容按 类别顺序 拼成最终发给AI的 instructions
function buildInstructions(settings) {
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

// 首屏提示语：从开着的 hint 卡片里每天随机选一条，同一天内保持不变（选中的卡片id存进settings，
// 不是纯算出来的，避免同一天内每次刷新设置页都重新抽一次）。一张都没开的话退回旧版遗留的 hintText 兜底。
function resolveHintText(settings) {
  const enabled = settings.promptCards.filter(
    (c) => c.category === HINT_CATEGORY && c.enabled && c.content && c.content.trim()
  );
  if (enabled.length === 0) return settings.hintText || DEFAULT_HINT_TEXT;
  const today = todayLocalDate();
  if (settings.hintPickDate === today) {
    const kept = enabled.find((c) => c.id === settings.hintPickCardId);
    if (kept) return kept.content;
  }
  const picked = enabled[Math.floor(Math.random() * enabled.length)];
  settings.hintPickDate = today;
  settings.hintPickCardId = picked.id;
  save(settings);
  return picked.content;
}

// 生成/更新"长期记忆"类下的卡片——固定只维护这一张，重复总结会覆盖上一次的内容
function upsertLongTermMemoryCard(settings, content) {
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

module.exports = {
  load,
  save,
  newProfile,
  newCard,
  activeProfile,
  buildInstructions,
  upsertLongTermMemoryCard,
  resolveHintText,
  CARD_CATEGORIES,
  ALL_CARD_CATEGORIES,
};
