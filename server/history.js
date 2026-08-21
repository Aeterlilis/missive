// 对话历史：每一轮"用户写的图 + AI的回复"存一条。
// 双重用途：① 给下一轮当滚动上下文（调用方只取最近几条）② 完整存档，可在"历史记录"页翻看/删除。
// 磁盘上留够多条（当存档用），只是防止真的无限增长。

const fs = require('fs');
const path = require('path');

const DIR = process.env.SETTINGS_DIR || __dirname;
const HISTORY_PATH = path.join(DIR, 'history.json');
const MAX_STORED = 2000;

function load() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list, null, 2));
}

function append(entry) {
  const list = load();
  list.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  while (list.length > MAX_STORED) list.shift();
  save(list);
  return list;
}

// 取"重置点"之后的最近 limit 轮，用作对话上下文
function recentContext(sinceIso, limit) {
  const list = load();
  const filtered = sinceIso ? list.filter((e) => e.timestamp > sinceIso) : list;
  return filtered.slice(-limit);
}

function remove(id) {
  const list = load().filter((e) => e.id !== id);
  save(list);
  return list;
}

module.exports = { load, append, recentContext, remove };
