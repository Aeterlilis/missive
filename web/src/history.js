// history.js —— 历史记录页：按"对话"分组成卡片 + 点开看这次对话写了哪几页 + 详情/删除

const listEl = document.getElementById('list');
const emptyHint = document.getElementById('emptyHint');

// 背景跟写字页/设置页保持一致，用同一套 body.theme-* class（见 paper-theme.css）
const THEME_CLASSES = ['theme-parchment', 'theme-lined', 'theme-grid', 'theme-xuanzhi', 'theme-watercolor', 'theme-crumpled', 'theme-black', 'theme-custom'];
function applyTheme(theme, bgColor) {
  document.body.classList.remove(...THEME_CLASSES);
  document.body.style.background = '';
  if (theme === 'custom') {
    document.body.classList.add('theme-custom');
    document.body.style.backgroundImage = `url(/api/background-image?t=${Date.now()})`;
  } else if (theme === 'solid') {
    document.body.style.background = bgColor || '#ffffff';
  } else if (theme && theme !== 'white') {
    document.body.classList.add('theme-' + theme);
  }
}
// 界面配色（日夜主题）：卡片/缩略图这些框框的底色+文字颜色，逻辑跟设置页 applyChromeTheme 一样
function applyChromeTheme(s) {
  const ink = s.chromeInk || '#000000';
  const boxHex = s.chromeBox || '#ffffff';
  const alpha = typeof s.chromeBoxAlpha === 'number' ? s.chromeBoxAlpha : 0.55;
  const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [ir, ig, ib] = hexToRgb(ink);
  const [br, bg, bb] = hexToRgb(boxHex);
  const root = document.documentElement.style;
  root.setProperty('--ink', ink);
  root.setProperty('--ink-faint', `rgba(${ir}, ${ig}, ${ib}, 0.15)`);
  root.setProperty('--box-bg', `rgba(${br}, ${bg}, ${bb}, ${alpha})`);
  root.setProperty('--box-solid', boxHex);
  // 玻璃强度："更透亮"换成更轻的模糊+更高饱和度+边缘高光，逻辑跟设置页 applyGlassIntensity 一样
  if (s.glassIntensity === 'enhanced') {
    let supportsDistortion = false;
    try { supportsDistortion = CSS.supports('backdrop-filter', 'url(#glass-distortion) blur(1px)'); } catch {}
    root.setProperty('--box-blur', `${supportsDistortion ? 'url(#glass-distortion) ' : ''}blur(6px) saturate(2)`);
    root.setProperty('--box-rim', 'inset 0 1px 1px rgba(255,255,255,.55), inset 0 -1px 1px rgba(0,0,0,.12)');
  }
}
fetch('/api/settings').then((r) => r.json()).then((s) => { applyTheme(s.theme, s.bgColor); applyChromeTheme(s); }).catch(() => {});

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDay(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 条目本来就是按时间倒序存的，同一次对话的 conversationId 必然连续出现，
// 单趟扫描就能分好组，不用额外排序。老数据没有 conversationId，统一归到一组。
function groupByConversation(entries) {
  const groups = [];
  let current = null;
  for (const entry of entries) {
    const cid = entry.conversationId ?? 'legacy';
    if (!current || current.cid !== cid) {
      current = { cid, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

async function load() {
  const res = await fetch('/api/history');
  const entries = await res.json();
  listEl.innerHTML = '';
  emptyHint.style.display = entries.length === 0 ? 'block' : 'none';
  for (const group of groupByConversation(entries)) {
    listEl.appendChild(buildConvCard(group));
  }
}

function buildConvCard(group) {
  const card = document.createElement('div');
  card.className = 'conv-card';

  const head = document.createElement('div');
  head.className = 'conv-head';
  head.addEventListener('click', () => card.classList.toggle('open'));

  const thumbSrc = group.entries.find((e) => e.imageDataUrl)?.imageDataUrl;
  if (thumbSrc) {
    const thumb = document.createElement('img');
    thumb.className = 'conv-thumb';
    thumb.src = thumbSrc;
    thumb.alt = '';
    head.appendChild(thumb);
  }

  const main = document.createElement('div');
  main.className = 'conv-main';
  const date = document.createElement('div');
  date.className = 'conv-date';
  date.textContent = fmtDay(group.entries[0].timestamp);
  const count = document.createElement('div');
  count.className = 'conv-count';
  count.textContent = `共 ${group.entries.length} 页`;
  main.appendChild(date);
  main.appendChild(count);
  head.appendChild(main);

  const chevron = document.createElement('span');
  chevron.className = 'conv-chevron';
  chevron.textContent = '展开';
  head.appendChild(chevron);

  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'conv-body';
  for (const entry of group.entries) {
    body.appendChild(buildEntryEl(entry));
  }
  card.appendChild(body);

  return card;
}

function buildEntryEl(entry) {
  const el = document.createElement('div');
  el.className = 'entry';

  const row = document.createElement('div');
  row.className = 'entry-row';
  row.addEventListener('click', () => el.classList.toggle('open'));

  if (entry.imageDataUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'entry-thumb';
    thumb.src = entry.imageDataUrl;
    thumb.alt = '';
    row.appendChild(thumb);
  }

  const main = document.createElement('div');
  main.className = 'entry-main';
  const date = document.createElement('div');
  date.className = 'entry-date';
  date.textContent = fmtDate(entry.timestamp);
  const snippet = document.createElement('div');
  snippet.className = 'entry-snippet';
  snippet.textContent = entry.reply || entry.userText || '';
  main.appendChild(date);
  main.appendChild(snippet);
  row.appendChild(main);
  el.appendChild(row);

  const detail = document.createElement('div');
  detail.className = 'entry-detail';
  if (entry.imageDataUrl) {
    const bigImg = document.createElement('img');
    bigImg.src = entry.imageDataUrl;
    bigImg.alt = '';
    detail.appendChild(bigImg);
  } else if (entry.userText) {
    const typed = document.createElement('div');
    typed.className = 'reply';
    typed.textContent = entry.userText;
    detail.appendChild(typed);
  }
  const reply = document.createElement('div');
  reply.className = 'reply';
  reply.textContent = entry.reply || '';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'entry-delete';
  delBtn.title = '删除';
  delBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('删除这条记录？删了就没了。')) return;
    await fetch('/api/history/' + entry.id, { method: 'DELETE' });
    await load();
  });
  detail.appendChild(reply);
  detail.appendChild(delBtn);
  el.appendChild(detail);

  return el;
}

load();
