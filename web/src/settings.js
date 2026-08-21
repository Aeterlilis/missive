// settings.js —— 设置页逻辑：多配置槽位的读写 + 拉取模型列表 + 全局设置。

const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let data = null;          // 最近一次从服务器拉到的完整设置
let currentProfileId = null; // 当前表单里正在编辑的配置槽位

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#c00' : '';
  if (text) setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

function renderProfileSelect() {
  const sel = $('profileSelect');
  sel.innerHTML = '';
  for (const p of data.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.hasKey ? '' : '（未配置）');
    sel.appendChild(opt);
  }
  sel.value = currentProfileId;
}

function fillProfileForm(id) {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return;
  currentProfileId = id;
  $('profileSelect').value = id;
  $('profileName').value = p.name || '';
  $('baseUrl').value = p.baseUrl || '';
  $('apiKey').value = '';
  $('apiKey').placeholder = p.hasKey ? '已设置，留空则不修改' : '还没有配置';
  $('model').value = p.model || '';
  $('modelStatus').textContent = '';
}

async function load() {
  try {
    const res = await fetch('/api/settings');
    data = await res.json();
    currentProfileId = data.activeProfileId;
    renderProfileSelect();
    fillProfileForm(currentProfileId);

    $('maxTokens').value = data.maxTokens || 280;
    renderAllCards();
    $('speed').value = data.speed || 6;
    const font = data.font || 'pinyon';
    const fontRadio = form.querySelector(`input[name="font"][value="${font}"]`);
    if (fontRadio) fontRadio.checked = true;

    $('hintText').value = data.hintText || '';
    const theme = data.theme || 'white';
    const themeRadio = form.querySelector(`input[name="theme"][value="${theme}"]`);
    if (themeRadio) themeRadio.checked = true;
    $('customBgStatus').textContent = data.hasCustomBackground ? '(已上传)' : '(还没上传)';

    $('contextCount').textContent = data.contextCount ?? 0;
    $('contextMax').textContent = data.contextTurns ?? 10;

    $('autoSendEnabled').checked = data.autoSendEnabled !== false;
    $('autoSendSeconds').value = data.autoSendSeconds ?? 2.8;
    $('fadeSeconds').value = data.fadeSeconds ?? 1.5;
    $('lingerSeconds').value = data.lingerSeconds ?? 7;
    $('inkLingerSeconds').value = data.inkLingerSeconds ?? 2;
    $('inkFadeSeconds').value = data.inkFadeSeconds ?? 0.9;
    $('penOnly').checked = !!data.penOnly;
  } catch (e) {
    setStatus('读取设置失败: ' + e.message, true);
  }
}

// ─── 提示词卡片 ─────────────────────────────────────
function renderAllCards() {
  for (const cat of ['ai_persona', 'user_persona', 'long_term_memory', 'other']) {
    renderCardList(cat);
  }
}

function renderCardList(category) {
  const list = document.querySelector(`.card-list[data-list="${category}"]`);
  list.innerHTML = '';
  const cards = data.promptCards.filter((c) => c.category === category);
  if (cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card-empty';
    empty.textContent = '还没有卡片';
    list.appendChild(empty);
    return;
  }
  for (const card of cards) {
    list.appendChild(buildCardEl(card));
  }
}

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card-item';
  el.dataset.id = card.id;

  const head = document.createElement('div');
  head.className = 'card-item-head';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = card.enabled;
  checkbox.className = 'card-enabled';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = card.title;
  titleInput.className = 'card-title';
  head.appendChild(checkbox);
  head.appendChild(titleInput);
  el.appendChild(head);

  const textarea = document.createElement('textarea');
  textarea.className = 'card-content';
  textarea.value = card.content;
  el.appendChild(textarea);

  const foot = document.createElement('div');
  foot.className = 'card-item-foot';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'card-delete';
  delBtn.textContent = '删除这张卡片';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`删除卡片"${card.title}"？`)) return;
    try {
      const res = await fetch('/api/cards/' + card.id, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || '删除失败');
      await load();
      setStatus('已删除');
    } catch (e) {
      setStatus('删除失败: ' + e.message, true);
    }
  });
  foot.appendChild(delBtn);
  el.appendChild(foot);

  return el;
}

document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const category = btn.dataset.add;
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, title: '新卡片', content: '' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '创建失败');
      await load();
      setStatus('已新建卡片，写好内容记得保存');
    } catch (e) {
      setStatus('新建失败: ' + e.message, true);
    }
  });
});

$('profileSelect').addEventListener('change', (e) => fillProfileForm(e.target.value));

$('addProfile').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新配置' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '创建失败');
    await load();
    fillProfileForm(out.profile.id);
    renderProfileSelect();
    setStatus('已新建配置，填好后记得保存');
  } catch (e) {
    setStatus('新建失败: ' + e.message, true);
  }
});

$('deleteProfile').addEventListener('click', async () => {
  if (data.profiles.length <= 1) {
    setStatus('至少要留一个配置', true);
    return;
  }
  if (!confirm(`确定删除配置"${$('profileName').value || '这个配置'}"吗？`)) return;
  try {
    const res = await fetch('/api/profiles/' + currentProfileId, { method: 'DELETE' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '删除失败');
    await load();
    setStatus('已删除');
  } catch (e) {
    setStatus('删除失败: ' + e.message, true);
  }
});

$('fetchModels').addEventListener('click', async () => {
  const btn = $('fetchModels');
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  if (!baseUrl) {
    $('modelStatus').textContent = '先填 API 基础 URL';
    return;
  }
  btn.disabled = true;
  $('modelStatus').textContent = '拉取中…';
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, profileId: currentProfileId }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '拉取失败');
    const list = $('modelList');
    list.innerHTML = '';
    for (const m of out.models) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
    $('modelStatus').textContent = out.models.length
      ? `共 ${out.models.length} 个模型，点模型输入框选一个`
      : '没拉到模型列表';
  } catch (e) {
    $('modelStatus').textContent = '拉取失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('bgFile').addEventListener('change', async () => {
  const file = $('bgFile').files[0];
  if (!file) return;
  $('customBgStatus').textContent = '(处理中…)';
  try {
    const imageDataUrl = await resizeImageToDataUrl(file, 1920, 0.85);
    const res = await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '上传失败');
    const customRadio = form.querySelector('input[name="theme"][value="custom"]');
    if (customRadio) customRadio.checked = true;
    $('customBgStatus').textContent = '(已上传)';
    setStatus('背景图已上传，记得点保存');
  } catch (e) {
    $('customBgStatus').textContent = '(上传失败)';
    setStatus('上传失败: ' + e.message, true);
  }
});

// 把用户选的图片文件缩放到最长边 maxSide 以内，转成 JPEG data URL，避免存超大原图
function resizeImageToDataUrl(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = URL.createObjectURL(file);
  });
}

$('resetContext').addEventListener('click', async () => {
  const summarize = $('summarizeOnReset').checked;
  const btn = $('resetContext');
  btn.disabled = true;
  setStatus(summarize ? '正在总结…' : '重置中…');
  try {
    const res = await fetch('/api/context/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summarize }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '重置失败');
    $('contextCount').textContent = 0;
    if (out.memoryCard) {
      await load(); // 刷新出新生成的长期记忆卡片
      setStatus('对话已重置，长期记忆已更新');
    } else {
      setStatus('对话已重置，下一页开始是全新的');
    }
  } catch (e) {
    setStatus('重置失败: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // 1. 保存当前配置槽位
    const profileBody = {
      name: $('profileName').value,
      baseUrl: $('baseUrl').value,
      model: $('model').value,
    };
    const apiKey = $('apiKey').value.trim();
    if (apiKey) profileBody.apiKey = apiKey;
    const pRes = await fetch('/api/profiles/' + currentProfileId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileBody),
    });
    if (!pRes.ok) throw new Error((await pRes.json()).error || '配置保存失败');

    // 2. 保存所有提示词卡片（标题/内容/开关）
    const cardEls = document.querySelectorAll('.card-item');
    await Promise.all(Array.from(cardEls).map((el) => {
      const id = el.dataset.id;
      const title = el.querySelector('.card-title').value;
      const content = el.querySelector('.card-content').value;
      const enabled = el.querySelector('.card-enabled').checked;
      return fetch('/api/cards/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, enabled }),
      });
    }));

    // 3. 保存全局设置 + 把当前配置设为使用中
    const font = form.querySelector('input[name="font"]:checked')?.value || 'pinyon';
    const theme = form.querySelector('input[name="theme"]:checked')?.value || 'white';
    const gRes = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxTokens: parseInt($('maxTokens').value, 10) || 280,
        speed: parseInt($('speed').value, 10) || 6,
        font,
        hintText: $('hintText').value,
        theme,
        autoSendEnabled: $('autoSendEnabled').checked,
        autoSendSeconds: parseFloat($('autoSendSeconds').value) || 2.8,
        fadeSeconds: parseFloat($('fadeSeconds').value) || 1.5,
        lingerSeconds: parseFloat($('lingerSeconds').value) || 7,
        inkLingerSeconds: parseFloat($('inkLingerSeconds').value) || 2,
        inkFadeSeconds: parseFloat($('inkFadeSeconds').value) || 0.9,
        penOnly: $('penOnly').checked,
        activeProfileId: currentProfileId,
      }),
    });
    if (!gRes.ok) throw new Error('设置保存失败');

    setStatus('已保存');
    await load();
  } catch (e) {
    setStatus('保存失败: ' + e.message, true);
  }
});

load();
