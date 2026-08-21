// history.js —— 历史记录页：列表 + 点开看详情 + 删除

const listEl = document.getElementById('list');
const emptyHint = document.getElementById('emptyHint');

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load() {
  const res = await fetch('/api/history');
  const entries = await res.json();
  listEl.innerHTML = '';
  emptyHint.style.display = entries.length === 0 ? 'block' : 'none';
  for (const entry of entries) {
    listEl.appendChild(buildEntryEl(entry));
  }
}

function buildEntryEl(entry) {
  const el = document.createElement('div');
  el.className = 'entry';

  const row = document.createElement('div');
  row.className = 'entry-row';
  row.addEventListener('click', () => el.classList.toggle('open'));

  const thumb = document.createElement('img');
  thumb.className = 'entry-thumb';
  thumb.src = entry.imageDataUrl;
  thumb.alt = '';

  const main = document.createElement('div');
  main.className = 'entry-main';
  const date = document.createElement('div');
  date.className = 'entry-date';
  date.textContent = fmtDate(entry.timestamp);
  const snippet = document.createElement('div');
  snippet.className = 'entry-snippet';
  snippet.textContent = entry.reply || '';
  main.appendChild(date);
  main.appendChild(snippet);

  row.appendChild(thumb);
  row.appendChild(main);
  el.appendChild(row);

  const detail = document.createElement('div');
  detail.className = 'entry-detail';
  const bigImg = document.createElement('img');
  bigImg.src = entry.imageDataUrl;
  bigImg.alt = '';
  const reply = document.createElement('div');
  reply.className = 'reply';
  reply.textContent = entry.reply || '';
  const delBtn = document.createElement('button');
  delBtn.className = 'entry-delete';
  delBtn.textContent = '删除这一条';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('删除这条记录？删了就没了。')) return;
    await fetch('/api/history/' + entry.id, { method: 'DELETE' });
    await load();
  });
  detail.appendChild(bigImg);
  detail.appendChild(reply);
  detail.appendChild(delBtn);
  el.appendChild(detail);

  return el;
}

load();
