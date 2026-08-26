// 浏览器本地存储。手机版没有后端，设置、历史记录、背景图、自定义字体全存这里。
//
// 为什么是 IndexedDB 而不是 localStorage：**历史记录每条都带着一张纸面截图**（PNG 的
// data URL，一条几十上百 KB），localStorage 统共就 5MB 左右，几十轮对话就撑爆了。
// 而且 localStorage 只能存字符串，背景图和字体文件塞进去还得先转 base64，白白胖三分之一。
//
// 两个仓：
//   kv      —— 只有一份的东西：设置、背景图、自定义字体。key 见下面的 KEYS。
//   history —— 每轮对话一条，主键是 entry.id，另按 timestamp 建了索引方便按时间取。
//
// 这个文件只管存取，不懂业务。设置该长什么样归 shared/settings-model.js 管。

const DB_NAME = 'missive';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const HISTORY_STORE = 'history';

export const KEYS = {
  settings: 'settings',     // 设置对象，形状见 shared/settings-model.js
  background: 'background', // 自定义纸张背景图，存 Blob
  cjkFont: 'cjkFont',       // 自定义中文字体，存 { name, ext, blob }
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const s = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // 另一个标签页开着旧版本的库时会走到这里。真发生了也只能提示用户关掉别的标签页，
    // 硬等下去页面会一直空着。
    req.onblocked = () => reject(new Error('数据库被其它标签页占着，关掉别的 Missive 标签页再试'));
  });
  return dbPromise;
}

// IndexedDB 全是事件回调，包成 Promise 好写。事务失败要报 tx.error 而不是 req.error——
// 写入超配额这类错是在事务上报出来的，只看请求会拿到一个 null，报错变成"未知错误"。
function run(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储事务被中断'));
  }));
}

// 把一个 IDBRequest 标记出来，让 run() 在事务完成后取它的结果
const asResult = (req) => ({ __req: req });

// ─── kv：只有一份的东西 ─────────────────────────
export const getKv = (key) => run(KV_STORE, 'readonly', (s) => asResult(s.get(key)));
export const setKv = (key, value) => run(KV_STORE, 'readwrite', (s) => asResult(s.put(value, key)));
export const delKv = (key) => run(KV_STORE, 'readwrite', (s) => asResult(s.delete(key)));

// ─── history：每轮对话一条 ───────────────────────
// 存的形状跟原来后端 history.json 里一条一模一样：
//   { id, timestamp, kind: 'ink'|'typed', imageDataUrl?, userText?, reply, conversationId }
// 历史页和上下文拼装都照着这个形状读，别改字段名。

const MAX_STORED = 2000; // 留够多条当存档用，只是防止真的无限长

// 按时间从早到晚。历史页要的是倒序，那边自己反过来——跟原来 GET /api/history 的行为一致。
export const historyAll = () => run(HISTORY_STORE, 'readonly', (s) => asResult(s.index('timestamp').getAll()));

export async function historyAppend(entry) {
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  await run(HISTORY_STORE, 'readwrite', (s) => { s.put(record); });
  await trimHistory();
  return record;
}

export const historyRemove = (id) => run(HISTORY_STORE, 'readwrite', (s) => asResult(s.delete(id)));

// 取"重置点"之后的最近 limit 轮，用作对话上下文
export async function historyRecent(sinceIso, limit) {
  const all = await historyAll();
  const filtered = sinceIso ? all.filter((e) => e.timestamp > sinceIso) : all;
  return filtered.slice(-limit);
}

// 超出上限就从最早的开始删。用游标一条条删而不是先 getAll——那会把两千张截图
// 一次性读进内存，几百 MB。
async function trimHistory() {
  const count = await run(HISTORY_STORE, 'readonly', (s) => asResult(s.count()));
  if (count <= MAX_STORED) return;
  let toDelete = count - MAX_STORED;
  await run(HISTORY_STORE, 'readwrite', (s) => {
    const req = s.index('timestamp').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || toDelete <= 0) return;
      cursor.delete();
      toDelete -= 1;
      cursor.continue();
    };
  });
}

// 整库清空。目前没有界面入口，留着给"从后端把数据导进来"那步做覆盖式导入用。
export async function clearAll() {
  await run(KV_STORE, 'readwrite', (s) => { s.clear(); });
  await run(HISTORY_STORE, 'readwrite', (s) => { s.clear(); });
}
