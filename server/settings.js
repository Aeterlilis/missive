// 设置持久化。网页版(局域网)存在 server/settings.json；
// 桌面版(Electron)通过 SETTINGS_DIR 环境变量指向 userData 目录，避免装到只读路径下写不进去。
//
// v2：支持多套 API 配置("配置槽位")。
// v3：人设从单个字符串变成"提示词卡片"系统——分 ai_persona/user_persona/long_term_memory/other
//     四类，每类下能建好几张卡片，每张能单独开关，最终发给AI的是所有开着的卡片内容拼起来。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_PERSONA } = require('./persona');

const DIR = process.env.SETTINGS_DIR || __dirname;
const SETTINGS_PATH = path.join(DIR, 'settings.json');
const LEGACY_ENV_PATH = path.join(__dirname, '.env');

const CARD_CATEGORIES = ['ai_persona', 'user_persona', 'long_term_memory', 'other'];

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
    promptCards: [newCard({ category: 'ai_persona', title: '默认人设', content: DEFAULT_PERSONA, enabled: true })],
    font: 'pinyon', // pinyon(花体) | medieval(哥特体) | wenkai(统一用文楷)
    speed: 6,       // 1(慢) ~ 10(快)
    hintText: '用笔在这里写点什么…\n比如：今天发生了什么',
    theme: 'white', // white | kraft | parchment | lined | grid | custom
    contextTurns: 10,     // 滚动上下文窗口大小
    contextResetAt: null, // 重置对话时间点；null 表示从最开始算
    autoSendEnabled: true,
    autoSendSeconds: 2.8, // 停笔多久后自动发送（仅 autoSendEnabled 时生效）
    fadeSeconds: 1.5,     // AI回复淡出的时长
    penOnly: false,       // 防误触：只认笔，忽略手指/手掌触摸
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

// 兼容老的单个 persona 字符串：升级成 ai_persona 类下的一张卡片
function migratePersonaToCards(raw) {
  if (Array.isArray(raw.promptCards)) return raw;
  const next = { ...raw };
  const content = typeof raw.persona === 'string' && raw.persona.trim() ? raw.persona : DEFAULT_PERSONA;
  next.promptCards = [newCard({ category: 'ai_persona', title: '默认人设', content, enabled: true })];
  delete next.persona;
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
      const merged = { ...defaultsWithProfile(), ...upgraded };
      if (!merged.profiles.some((p) => p.id === merged.activeProfileId)) {
        merged.activeProfileId = merged.profiles[0].id;
      }
      if (wasFlat || wasFlatPersona) save(merged); // 落盘一次，避免每次读取都重新迁移
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
  CARD_CATEGORIES,
};
