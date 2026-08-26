// 设置持久化——这个文件只管"存在哪"：网页版(局域网)存在 server/settings.json；
// 桌面版(Electron)通过 SETTINGS_DIR 环境变量指向 userData 目录，避免装到只读路径下写不进去。
//
// 数据本身的规矩（默认值长什么样、老格式怎么升级、人设怎么拼、首屏提示语怎么抽）
// 在 web/src/shared/settings-model.js，跟手机版共用同一份，见 ./shared.js。
// 手机上没有后端，那些逻辑得在浏览器里跑，两边必须逐字一致，不然存出来的设置对不上。

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const DIR = process.env.SETTINGS_DIR || __dirname;
const SETTINGS_PATH = path.join(DIR, 'settings.json');
const LEGACY_ENV_PATH = path.join(__dirname, '.env');

const model = () => shared.get('settingsModel');

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
    const p = model().newProfile({
      baseUrl: get('OPENAI_BASE_URL'),
      apiKey,
      model: get('OPENAI_MODEL'),
      spec: 'responses', // .env 那个年代只有 Responses 一种接口
    });
    return {
      ...model().defaults(),
      profiles: [p],
      activeProfileId: p.id,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 280,
    };
  } catch {
    return null;
  }
}

function load() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      const { settings, changed } = model().upgrade(raw);
      if (changed) save(settings); // 落盘一次，避免每次读取都重新迁移
      return settings;
    } catch {
      return model().defaults();
    }
  }
  const initial = migrateFromEnv() || model().defaults();
  save(initial);
  return initial;
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// 抽中新的一条要落盘，不然同一天内每次刷新都会重抽。落盘怎么做只有这边知道，
// 所以共用那份只管抽，抽完报告一句"变了没有"。
function resolveHintText(settings) {
  const { text, changed } = model().resolveHintText(settings);
  if (changed) save(settings);
  return text;
}

module.exports = {
  load,
  save,
  resolveHintText,
  newProfile: (...a) => model().newProfile(...a),
  newCard: (...a) => model().newCard(...a),
  activeProfile: (...a) => model().activeProfile(...a),
  publicProfile: (...a) => model().publicProfile(...a),
  publicSettings: (...a) => model().publicSettings(...a),
  applySettingsPatch: (...a) => model().applySettingsPatch(...a),
  profileFromInput: (...a) => model().profileFromInput(...a),
  applyProfilePatch: (...a) => model().applyProfilePatch(...a),
  applyCardPatch: (...a) => model().applyCardPatch(...a),
  buildInstructions: (...a) => model().buildInstructions(...a),
  upsertLongTermMemoryCard: (...a) => model().upsertLongTermMemoryCard(...a),
  get CARD_CATEGORIES() { return model().CARD_CATEGORIES; },
  get ALL_CARD_CATEGORIES() { return model().ALL_CARD_CATEGORIES; },
};
