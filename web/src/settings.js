// settings.js —— 设置页逻辑：多配置槽位的读写 + 拉取模型列表 + 全局设置。
// v2：卡片化——API配置/人设/记忆都是"堆叠→点开→点进单张编辑"的卡片，系统提示词是平铺开关列表。

const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let data = null;             // 最近一次从服务器拉到的完整设置
let currentProfileId = null; // 当前"待启用"的配置槽位（真正生效要点保存）
let themeColorHex = '#000000'; // 开关/滑块的统一主题色
let bgColorHex = '#ffffff';    // 纸张背景选"纯色"时用的颜色
let chromeInkHex = '#000000';  // 界面配色：文字/边框颜色
let chromeBoxHex = '#ffffff';  // 界面配色：所有卡片/面板/按钮的底色（配合下面的透明度）
let chromeBoxAlpha = 0.55;     // 界面配色：底色的透明度

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#c00' : '';
  if (text) setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

// 背景跟写字页保持一致，用同一套 body.theme-* class（见 paper-theme.css）。
// "纯色"（solid）不在这里——颜色是用户自己调的，直接内联 style，不走 class。
const THEME_CLASSES = ['theme-parchment', 'theme-lined', 'theme-grid', 'theme-xuanzhi', 'theme-watercolor', 'theme-crumpled', 'theme-black', 'theme-custom'];
function applyTheme(theme, bgColor) {
  document.body.classList.remove(...THEME_CLASSES);
  document.body.style.background = ''; // 先清掉上一个主题可能留下的内联背景（自定义图片/纯色都是内联设的）
  if (theme === 'custom') {
    document.body.classList.add('theme-custom');
    document.body.style.backgroundImage = `url(/api/background-image?t=${Date.now()})`;
  } else if (theme === 'solid') {
    document.body.style.background = bgColor || '#ffffff';
  } else if (theme && theme !== 'white') {
    document.body.classList.add('theme-' + theme);
  }
}

// "纯色"选好之后才会露出下面这块选色盘，切到别的背景就收起来
function syncBgPickerVisibility(theme) {
  $('bg-solid-color-picker').classList.toggle('hidden', theme !== 'solid');
}

// 单选胶囊组（字体/纸张背景都用这个）：点哪个哪个变黑，data-value 就是选中值。
// 自定义图片那个是 <label for="bgFile">，点击原生就会弹文件选择框，不用额外接点击事件。
function setupOptionPills(groupName, onSelect) {
  const pills = [...document.querySelectorAll(`.option-pills[data-group="${groupName}"] .option-pill`)];
  function setActive(value) {
    pills.forEach((p) => p.classList.toggle('active', p.dataset.value === value));
  }
  function getActive() {
    return pills.find((p) => p.classList.contains('active'))?.dataset.value;
  }
  pills.forEach((p) => {
    if (p.tagName === 'LABEL') return; // 自定义图片那个靠 change 事件，不是点它就选中
    p.addEventListener('click', () => { setActive(p.dataset.value); onSelect?.(p.dataset.value); });
  });
  return { setActive, getActive };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// 中文手写字体：默认/自定义两个胶囊，自定义那个是 <label for="cjkFontFile">。
// 桌面版（Electron）额外多一行"从系统字体库选"，读到文件后走的是同一条上传接口。
function setupCjkFontPills() {
  const wrap = document.querySelector('.option-pills[data-group="cjkFont"]');
  const customPill = $('cjkFontCustomPill');
  const presetPills = [...wrap.querySelectorAll('.option-pill')].filter((p) => p.tagName !== 'LABEL'); // 排除"上传字体文件"那个 <label>，它靠 change 事件选中
  const fileInput = $('cjkFontFile');

  function setActive(value) {
    wrap.querySelectorAll('.option-pill').forEach((p) => p.classList.toggle('active', p.dataset.value === value));
  }
  function getActive() {
    return wrap.querySelector('.option-pill.active')?.dataset.value || 'default';
  }

  presetPills.forEach((p) => p.addEventListener('click', () => setActive(p.dataset.value)));

  async function uploadFontBase64(base64, filename) {
    const prevText = customPill.textContent;
    customPill.textContent = '上传中…';
    try {
      const res = await fetch('/api/cjk-font', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, fontDataBase64: base64 }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '上传失败');
      setActive('custom');
      customPill.textContent = out.cjkFontName;
      setStatus('字体已上传并选中，写字页刷新一下就能看到效果，记得点保存');
    } catch (e) {
      customPill.textContent = prevText;
      setStatus('字体上传失败: ' + e.message, true);
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const base64 = await fileToBase64(file);
    uploadFontBase64(base64, file.name);
  });

  // 桌面版专属：Electron 的 preload 暴露了 electronAPI 才有这一段，网页/手机访问是没有的
  if (window.electronAPI) {
    const row = $('cjkFontElectronRow');
    const select = $('cjkFontSystemSelect');
    row.classList.remove('hidden');
    window.electronAPI.listSystemFonts().then((fonts) => {
      select.innerHTML = '';
      for (const f of fonts) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.name;
        select.appendChild(opt);
      }
    });
    $('cjkFontSystemUse').addEventListener('click', async () => {
      const filePath = select.value;
      if (!filePath) return;
      try {
        const { base64, filename } = await window.electronAPI.readFontFile(filePath);
        await uploadFontBase64(base64, filename);
      } catch (e) {
        setStatus('读取系统字体失败: ' + e.message, true);
      }
    });
  }

  return { setActive, getActive };
}

function applyThemeColor(hex) {
  themeColorHex = hex;
  document.documentElement.style.setProperty('--accent', hex);
}

const CHROME_PRESETS = {
  day: { ink: '#000000', box: '#ffffff', alpha: 0.55 },
  night: { ink: '#ffffff', box: '#000000', alpha: 0.55 },
};

function hexToRgbTriplet(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let glassMode = 'standard'; // 'standard' | 'enhanced' —— applyChromeTheme 改 ink 的时候要知道当前是哪档，才能同步更新边框颜色

// 界面配色：所有"框框"共用的底色（颜色+透明度）和文字/边框色。
// --box-solid/--ink-faint 是从这两个值派生出来的，给缩略图底板、按钮悬浮反色、细分隔线这些
// 必须用不透明色/极淡色的地方用，见 chrome-theme.css 顶部注释。
function applyChromeTheme(ink, boxHex, alpha) {
  chromeInkHex = ink;
  chromeBoxHex = boxHex;
  chromeBoxAlpha = alpha;
  const [ir, ig, ib] = hexToRgbTriplet(ink);
  const [br, bg, bb] = hexToRgbTriplet(boxHex);
  const root = document.documentElement.style;
  root.setProperty('--ink', ink);
  root.setProperty('--ink-faint', `rgba(${ir}, ${ig}, ${ib}, 0.15)`);
  root.setProperty('--box-bg', `rgba(${br}, ${bg}, ${bb}, ${alpha})`);
  root.setProperty('--box-solid', boxHex);
  refreshBoxBorderColor();
}

function syncChromeCustomVisibility(mode) {
  $('chrome-theme-custom').classList.toggle('hidden', mode !== 'custom');
}

// 折射扭曲（url(#glass-distortion)）不是所有浏览器都支持，先探测一下，
// 不支持就退回纯模糊——不然直接把 url() 塞进 backdrop-filter，在不认识它的浏览器上
// 整条 backdrop-filter 会连模糊都一起失效，比啥都没有还难看。
const GLASS_DISTORTION_SUPPORTED = (() => {
  try { return CSS.supports('backdrop-filter', 'url(#glass-distortion) blur(1px)'); } catch { return false; }
})();

// 折射扭曲的强度在鼠标驱动的桌面端和触屏端渲染出来的观感差很多（同一个 scale 桌面端会糊成
// 波浪，触屏端却刚刚好）——用 pointer:coarse 粗略分个类，桌面（细指针/鼠标）给一个弱得多的值。
function tuneDistortionScale() {
  const map = document.querySelector('#glass-distortion feDisplacementMap');
  if (!map) return;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  map.setAttribute('scale', coarse ? '35' : '14');
}

// "更透亮"档的边框不再靠实线撑轮廓，改成 ink 的极淡版（跟 --ink-faint 一个思路，但透明度更低），
// 让 --box-rim 的内阴影高光/暗角去表达边缘。ink 颜色变了、或者玻璃档位切换了，都要重新算一遍。
function refreshBoxBorderColor() {
  const root = document.documentElement.style;
  if (glassMode === 'enhanced') {
    const [ir, ig, ib] = hexToRgbTriplet(chromeInkHex);
    root.setProperty('--box-border-color', `rgba(${ir}, ${ig}, ${ib}, 0.1)`);
  } else {
    root.setProperty('--box-border-color', 'var(--ink)');
  }
}

// PS 那套"斜面浮雕+内阴影+内发光+叠光泽+投影"图层样式的 CSS 翻译，几层 box-shadow 叠起来：
// 外层投影负责浮起来的感觉；两道极窄的内嵌高光/暗角是斜面的硬边转折（贴着轮廓，不模糊）；
// 内发光是不分方向、整圈都有的一层亮，对应"整个轮廓都透光，背光面也会反光"；内阴影用更大的
// 模糊半径往里推，让暗部落在偏中间的位置而不是死贴着边——这样才不会看起来像一整块实心凸起的
// 塑料，而是有光线穿过的曲面。
const GLASS_RIM = '0 3px 12px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.55), inset 0 -1px 0 rgba(0,0,0,.12), inset 0 0 8px rgba(255,255,255,.28), inset 0 -5px 14px rgba(0,0,0,.07)';

// 玻璃强度："标准"就是 chrome-theme.css 里定义的默认值；"更透亮"把模糊调轻、饱和度调高，
// 边框淡到几乎看不见、换 GLASS_RIM 那一叠阴影/高光表达轮廓，支持的话再叠一层真正的折射扭曲，
// 几样加起来才是用户说的"不是随便糊了个模糊"的液态玻璃感。
function applyGlassIntensity(mode) {
  glassMode = mode;
  const root = document.documentElement.style;
  if (mode === 'enhanced') {
    const distortion = GLASS_DISTORTION_SUPPORTED ? 'url(#glass-distortion) ' : '';
    root.setProperty('--box-blur', `${distortion}blur(6px) saturate(2)`);
    root.setProperty('--box-rim', GLASS_RIM);
    tuneDistortionScale();
  } else {
    root.setProperty('--box-blur', 'blur(16px) saturate(1.6)');
    root.setProperty('--box-rim', 'none');
  }
  refreshBoxBorderColor();
}

// 通用 HSB方形/色环 选色盘——主题色跟纸张纯色背景共用同一份实现，靠 ids/presetsSelector 挂到不同的 DOM 上。
// 跟写字页笔刷颜色（app.js）那套预设色块+方形/色环自定义面板也是完全同一套算法。
function setupColorPicker({ ids, presetsSelector, getInitial, onChange, statusMsg }) {
  const panel = $(ids.panel);
  const svCanvas = $(ids.sv);
  const hueCanvas = $(ids.hue);
  const wheelCanvas = $(ids.wheel);
  const modeSquare = $(ids.modeSquare);
  const modeTabs = panel.querySelectorAll('.color-mode-tab');
  const svCtx = svCanvas.getContext('2d');
  const hueCtx = hueCanvas.getContext('2d');
  const wheelCtx = wheelCanvas.getContext('2d');
  const colorPreview = $(ids.preview);
  const colorHex = $(ids.hex);
  const btnCustomColor = $(ids.customBtn);
  const presetSwatches = document.querySelectorAll(presetsSelector);
  const presetColors = Array.from(presetSwatches).map((b) => b.dataset.color.toLowerCase());

  let currentHex = getInitial();
  let hue = 0, sat = 0, val = 0;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  function drawHueStrip() {
    const grad = hueCtx.createLinearGradient(0, 0, hueCanvas.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hueCtx.fillStyle = grad;
    hueCtx.fillRect(0, 0, hueCanvas.width, hueCanvas.height);
  }
  function drawSvSquare() {
    const w = svCanvas.width, h = svCanvas.height;
    const satGrad = svCtx.createLinearGradient(0, 0, w, 0);
    satGrad.addColorStop(0, '#fff');
    satGrad.addColorStop(1, `hsl(${hue},100%,50%)`);
    svCtx.fillStyle = satGrad;
    svCtx.fillRect(0, 0, w, h);
    const valGrad = svCtx.createLinearGradient(0, 0, 0, h);
    valGrad.addColorStop(0, 'rgba(0,0,0,0)');
    valGrad.addColorStop(1, '#000');
    svCtx.fillStyle = valGrad;
    svCtx.fillRect(0, 0, w, h);
    const cx = sat * w, cy = (1 - val) * h;
    svCtx.beginPath();
    svCtx.arc(cx, cy, 5, 0, Math.PI * 2);
    svCtx.strokeStyle = val > 0.6 && sat < 0.6 ? '#000' : '#fff';
    svCtx.lineWidth = 2;
    svCtx.stroke();
  }

  function wheelGeometry() {
    const w = wheelCanvas.width, h = wheelCanvas.height;
    const cx = w / 2, cy = h / 2;
    const outerR = Math.min(cx, cy) - 2;
    const ringWidth = Math.max(14, outerR * 0.16);
    const innerR = outerR - ringWidth;
    const triR = innerR - 6;
    return { w, h, cx, cy, outerR, innerR, triR };
  }
  function triangleVertices(hueDeg, cx, cy, r) {
    const rad = (deg) => (deg * Math.PI) / 180;
    const aFull = rad(hueDeg), aWhite = aFull + rad(120), aBlack = aFull + rad(240);
    return {
      A: { x: cx + r * Math.cos(aFull), y: cy + r * Math.sin(aFull) },
      B: { x: cx + r * Math.cos(aWhite), y: cy + r * Math.sin(aWhite) },
      C: { x: cx + r * Math.cos(aBlack), y: cy + r * Math.sin(aBlack) },
    };
  }
  function barycentric(x, y, A, B, C) {
    const denom = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const wA = ((B.y - C.y) * (x - C.x) + (C.x - B.x) * (y - C.y)) / denom;
    const wB = ((C.y - A.y) * (x - C.x) + (A.x - C.x) * (y - C.y)) / denom;
    return [wA, wB, 1 - wA - wB];
  }
  function drawWheel() {
    const { w, h, cx, cy, outerR, innerR, triR } = wheelGeometry();
    const { A, B, C } = triangleVertices(hue, cx, cy, triR);
    const img = wheelCtx.createImageData(w, h);
    const dataArr = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r <= outerR && r >= innerR) {
          let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (ang < 0) ang += 360;
          const [pr, pg, pb] = hsvToRgb(ang, 1, 1);
          dataArr[i] = pr; dataArr[i + 1] = pg; dataArr[i + 2] = pb; dataArr[i + 3] = 255;
        } else if (r < innerR) {
          const [wA, wB, wC] = barycentric(x, y, A, B, C);
          if (wA >= -0.01 && wB >= -0.01 && wC >= -0.01) {
            const s = Math.min(1, Math.max(0, wA));
            const v = Math.min(1, Math.max(0, wA + wB));
            const [pr, pg, pb] = hsvToRgb(hue, s, v);
            dataArr[i] = pr; dataArr[i + 1] = pg; dataArr[i + 2] = pb; dataArr[i + 3] = 255;
          }
        }
      }
    }
    wheelCtx.putImageData(img, 0, 0);

    const markR = (innerR + outerR) / 2;
    const rad = (hue * Math.PI) / 180;
    wheelCtx.beginPath();
    wheelCtx.arc(cx + markR * Math.cos(rad), cy + markR * Math.sin(rad), 5, 0, Math.PI * 2);
    wheelCtx.strokeStyle = '#fff'; wheelCtx.lineWidth = 3; wheelCtx.stroke();
    wheelCtx.strokeStyle = '#000'; wheelCtx.lineWidth = 1; wheelCtx.stroke();

    const pwA = Math.min(1, Math.max(0, sat)), pwB = Math.min(1, Math.max(0, val - sat));
    const pwC = Math.max(0, 1 - pwA - pwB);
    const px = pwA * A.x + pwB * B.x + pwC * C.x, py = pwA * A.y + pwB * B.y + pwC * C.y;
    wheelCtx.beginPath();
    wheelCtx.arc(px, py, 5, 0, Math.PI * 2);
    wheelCtx.strokeStyle = val > 0.6 && sat < 0.6 ? '#000' : '#fff';
    wheelCtx.lineWidth = 2;
    wheelCtx.stroke();
  }

  let wheelZone = null;
  let wheelDragging = false;
  function setFromWheelEvent(e) {
    const { cx, cy, outerR, innerR, triR } = wheelGeometry();
    const rect = wheelCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (wheelCanvas.width / rect.width);
    const y = (e.clientY - rect.top) * (wheelCanvas.height / rect.height);
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (wheelZone === null) wheelZone = r >= innerR ? 'ring' : 'triangle';
    if (wheelZone === 'ring') {
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      hue = ang;
    } else {
      const { A, B, C } = triangleVertices(hue, cx, cy, triR);
      const [wA, wB] = barycentric(x, y, A, B, C);
      sat = Math.min(1, Math.max(0, wA));
      val = Math.min(1, Math.max(0, wA + wB));
    }
    drawWheel();
  }
  wheelCanvas.addEventListener('pointerdown', (e) => {
    wheelZone = null;
    wheelDragging = true;
    try { wheelCanvas.setPointerCapture(e.pointerId); } catch {}
    setFromWheelEvent(e);
    applyCustomColor(false);
  });
  wheelCanvas.addEventListener('pointermove', (e) => {
    if (!wheelDragging) return;
    setFromWheelEvent(e);
    applyCustomColor(false);
  });
  wheelCanvas.addEventListener('pointerup', () => {
    if (!wheelDragging) return;
    wheelDragging = false;
    wheelZone = null;
    applyCustomColor(true);
  });

  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      modeTabs.forEach((t) => t.classList.toggle('active', t === tab));
      const wheelMode = tab.dataset.mode === 'wheel';
      modeSquare.classList.toggle('hidden', wheelMode);
      wheelCanvas.classList.toggle('hidden', !wheelMode);
      if (wheelMode) drawWheel(); else drawSvSquare();
    });
  });

  function applyCustomColor(save) {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    const hex = rgbToHex(r, g, b);
    currentHex = hex;
    onChange(hex);
    colorHex.value = hex;
    colorPreview.style.background = hex;
    syncColorUI();
    if (save) setStatus(statusMsg);
  }

  function setHueFromEvent(e) {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    hue = (x / rect.width) * 360;
    drawSvSquare();
  }
  function setSvFromEvent(e) {
    const rect = svCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    sat = x / rect.width;
    val = 1 - y / rect.height;
    drawSvSquare();
  }
  function bindDrag(el, onMove) {
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      onMove(e);
      applyCustomColor(false);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      onMove(e);
      applyCustomColor(false);
    });
    el.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      applyCustomColor(true);
    });
  }
  bindDrag(hueCanvas, setHueFromEvent);
  bindDrag(svCanvas, setSvFromEvent);

  btnCustomColor.addEventListener('click', () => {
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (opening) {
      [hue, sat, val] = rgbToHsv(...hexToRgb(currentHex));
      drawHueStrip();
      drawSvSquare();
      drawWheel();
      colorHex.value = currentHex;
      colorPreview.style.background = currentHex;
    }
  });

  colorHex.addEventListener('change', () => {
    let hex = colorHex.value.trim().toLowerCase();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (!/^#[0-9a-f]{6}$/.test(hex)) { colorHex.value = currentHex; return; }
    currentHex = hex;
    [hue, sat, val] = rgbToHsv(...hexToRgb(hex));
    drawSvSquare();
    drawWheel();
    onChange(hex);
    colorPreview.style.background = hex;
    syncColorUI();
    setStatus(statusMsg);
  });

  presetSwatches.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentHex = btn.dataset.color;
      onChange(currentHex);
      panel.classList.add('hidden');
      syncColorUI();
      setStatus(statusMsg);
    });
  });

  function syncColorUI() {
    const current = currentHex.toLowerCase();
    const isPreset = presetColors.includes(current);
    presetSwatches.forEach((b) => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === current);
    });
    btnCustomColor.classList.toggle('active', !isPreset);
    btnCustomColor.style.background = isPreset ? '' : current;
  }

  // 供 load() 在拉到服务器的值之后调用，把选色盘UI同步成当前值（不触发 onChange/保存提示）
  function setHex(hex) {
    currentHex = hex;
    syncColorUI();
  }

  return { syncColorUI, setHex };
}

// 分区导航：点了跳转（浏览器原生锚点跳转即可，html{scroll-behavior:smooth}负责平滑），
// 顺便用 IntersectionObserver 高亮当前滚动到的分区
function setupSectionNav() {
  const navLinks = [...document.querySelectorAll('#settings-nav a')];
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const href = '#' + entry.target.id;
      navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === href));
    }
  }, { rootMargin: '-128px 0px -55% 0px', threshold: 0 });
  navLinks.forEach((a) => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) observer.observe(target);
  });
}

// ─── 小图标（纯线条，跟其他页面同一套风格） ───────────────
const KEY_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="13" r="3"/><path d="M9.2 10.8 16 4M13 7l2 2M16 4l1.5 1.5"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a3 3 0 0 0 4.5 2.6l2-2A3 3 0 0 0 12.2 8"/><path d="M12 8a3 3 0 0 0-4.5-2.6l-2 2A3 3 0 0 0 7.8 12"/></svg>';
const MODEL_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 5.5h14v8H8l-3.5 3v-3H3z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';

function iconSpan(svg) {
  const span = document.createElement('span');
  span.innerHTML = svg;
  span.style.display = 'flex';
  return span.firstElementChild ? span : span;
}

function truncate(text, n) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '（还没写内容）';
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 堆叠组的展开/收起：折叠态点露出来的那张卡（哪里都行）展开；
// 展开态点第一张卡的标题区把整组收回去。返回 true 表示这次点击已经被这套逻辑接管了。
function handleStackClick(card, head, e) {
  const stack = card.closest('.card-stack');
  if (!stack) return false;
  if (stack.classList.contains('collapsed')) {
    if (stack.classList.contains('has-more')) {
      stackState[stack.dataset.stack] = false;
      stack.classList.remove('collapsed');
    }
    return true;
  }
  const isFront = card === stack.querySelector('.card:first-child');
  if (isFront && head.contains(e.target) && stack.classList.contains('has-more')) {
    stackState[stack.dataset.stack] = true;
    stack.classList.add('collapsed');
    return true;
  }
  return false;
}

function setCardEditing(card, editing) {
  card.classList.toggle('editing', editing);
  card.querySelectorAll('input[type="text"], input[type="password"], textarea').forEach((el) => {
    el.readOnly = !editing;
  });
}

function buildSwitch(checked, inputClass) {
  const wrap = document.createElement('span');
  wrap.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.className = inputClass;
  const track = document.createElement('span');
  track.className = 'switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  track.appendChild(thumb);
  wrap.appendChild(input);
  wrap.appendChild(track);
  return wrap;
}

function buildDeleteFab(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-delete-fab';
  btn.title = '删除';
  btn.appendChild(iconSpan(TRASH_ICON));
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function previewRow(svg, text) {
  const row = document.createElement('div');
  row.className = 'card-preview-row';
  row.appendChild(iconSpan(svg));
  const span = document.createElement('span');
  span.textContent = text;
  row.appendChild(span);
  return row;
}

function fieldLabel(labelText, type, className, value, placeholder) {
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = className;
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.autocomplete = 'off';
  input.readOnly = true;
  label.appendChild(span);
  label.appendChild(input);
  return label;
}

// ─── API 配置卡片（互斥选择：打勾圆圈） ───────────────────
function buildProfileCard(profile) {
  const card = document.createElement('div');
  card.className = 'card profile-card';
  card.dataset.id = profile.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'card-title-input field-name';
  titleInput.value = profile.name || '';
  titleInput.readOnly = true;
  head.appendChild(titleInput);

  const radio = document.createElement('button');
  radio.type = 'button';
  radio.className = 'check-radio' + (profile.id === currentProfileId ? ' selected' : '');
  radio.title = '设为当前使用的配置';
  radio.appendChild(iconSpan(CHECK_ICON));
  radio.addEventListener('click', (e) => {
    e.stopPropagation();
    currentProfileId = profile.id;
    document.querySelectorAll('.check-radio').forEach((b) => b.classList.remove('selected'));
    radio.classList.add('selected');
  });
  head.appendChild(radio);
  card.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'card-preview-rows';
  preview.appendChild(previewRow(KEY_ICON, profile.hasKey ? '已设置' : '还没配置'));
  preview.appendChild(previewRow(LINK_ICON, profile.baseUrl || '还没填 URL'));
  preview.appendChild(previewRow(MODEL_ICON, profile.model || '还没选模型'));
  card.appendChild(preview);

  const editRows = document.createElement('div');
  editRows.className = 'card-edit-rows';
  editRows.appendChild(fieldLabel('API 基础 URL', 'text', 'field-baseurl', profile.baseUrl, 'https://xxx.com/v1'));
  editRows.appendChild(fieldLabel('API 密钥', 'password', 'field-apikey', '', profile.hasKey ? '已设置，留空则不修改' : '还没有配置'));

  const modelWrap = document.createElement('label');
  const modelSpan = document.createElement('span');
  modelSpan.textContent = '模型名称';
  modelWrap.appendChild(modelSpan);
  const modelRow = document.createElement('div');
  modelRow.className = 'model-row';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.className = 'field-model';
  modelInput.value = profile.model || '';
  modelInput.readOnly = true;
  modelInput.setAttribute('list', 'modelList-' + profile.id);
  const fetchBtn = document.createElement('button');
  fetchBtn.type = 'button';
  fetchBtn.className = 'secondary small';
  fetchBtn.textContent = '获取模型列表';
  const modelStatus = document.createElement('span');
  modelStatus.className = 'hint';
  const datalist = document.createElement('datalist');
  datalist.id = 'modelList-' + profile.id;
  fetchBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const baseUrl = card.querySelector('.field-baseurl').value.trim();
    const apiKey = card.querySelector('.field-apikey').value.trim();
    if (!baseUrl) { modelStatus.textContent = '先填 API 基础 URL'; return; }
    fetchBtn.disabled = true;
    modelStatus.textContent = '拉取中…';
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, profileId: profile.id }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '拉取失败');
      datalist.innerHTML = '';
      for (const m of out.models) {
        const opt = document.createElement('option');
        opt.value = m;
        datalist.appendChild(opt);
      }
      modelStatus.textContent = out.models.length ? `共 ${out.models.length} 个模型` : '没拉到模型列表';
    } catch (err) {
      modelStatus.textContent = '拉取失败: ' + err.message;
    } finally {
      fetchBtn.disabled = false;
    }
  });
  modelRow.appendChild(modelInput);
  modelRow.appendChild(fetchBtn);
  modelWrap.appendChild(modelRow);
  modelWrap.appendChild(modelStatus);
  modelWrap.appendChild(datalist);
  editRows.appendChild(modelWrap);
  card.appendChild(editRows);

  card.addEventListener('click', (e) => {
    if (radio.contains(e.target) || e.target.closest('.card-delete-fab')) return;
    if (handleStackClick(card, head, e)) return;
    const isTypingIntoField = card.classList.contains('editing') && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (isTypingIntoField) return; // 编辑态点输入框本身是正常打字，不要收起
    setCardEditing(card, !card.classList.contains('editing'));
  });

  card.appendChild(buildDeleteFab(async () => {
    if (data.profiles.length <= 1) { setStatus('至少要留一个配置', true); return; }
    if (!confirm(`删除配置"${profile.name}"？`)) return;
    try {
      const res = await fetch('/api/profiles/' + profile.id, { method: 'DELETE' });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '删除失败');
      await load();
      setStatus('已删除');
    } catch (err) {
      setStatus('删除失败: ' + err.message, true);
    }
  }));

  return card;
}

// ─── 提示词卡片（人设/记忆/系统提示词/首屏提示语，堆叠展示，开关可多选） ─────────
function buildPromptCard(cardData) {
  const card = document.createElement('div');
  card.className = 'card prompt-card';
  card.dataset.id = cardData.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'card-title-input field-title';
  titleInput.value = cardData.title || '';
  titleInput.readOnly = true;
  head.appendChild(titleInput);

  const sw = buildSwitch(cardData.enabled, 'field-enabled');
  head.appendChild(sw);
  card.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'card-preview-rows';
  const row = document.createElement('div');
  row.className = 'card-preview-row';
  const snippet = document.createElement('span');
  snippet.textContent = truncate(cardData.content, 64);
  row.appendChild(snippet);
  preview.appendChild(row);
  card.appendChild(preview);

  const editRows = document.createElement('div');
  editRows.className = 'card-edit-rows';
  const ta = document.createElement('textarea');
  ta.className = 'field-content';
  ta.value = cardData.content || '';
  ta.readOnly = true;
  editRows.appendChild(ta);
  card.appendChild(editRows);

  card.addEventListener('click', (e) => {
    if (sw.contains(e.target) || e.target.closest('.card-delete-fab')) return;
    if (handleStackClick(card, head, e)) return;
    const isTypingIntoField = card.classList.contains('editing') && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (isTypingIntoField) return; // 编辑态点输入框本身是正常打字，不要收起
    setCardEditing(card, !card.classList.contains('editing'));
  });

  card.appendChild(buildDeleteFab(async () => {
    if (!confirm(`删除卡片"${cardData.title}"？`)) return;
    try {
      const res = await fetch('/api/cards/' + cardData.id, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || '删除失败');
      await load();
      setStatus('已删除');
    } catch (err) {
      setStatus('删除失败: ' + err.message, true);
    }
  }));

  return card;
}

// ─── 卡片组渲染：堆叠态默认收起，只露前面一张 ──────────────
const stackState = { profiles: true, ai_persona: true, user_persona: true, long_term_memory: true, other: true, hint: true };

function renderCardStack(category, exclusive) {
  const stackEl = document.querySelector(`.card-stack[data-stack="${category}"]`);
  stackEl.innerHTML = '';
  const items = category === 'profiles' ? data.profiles : data.promptCards.filter((c) => c.category === category);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card-empty';
    empty.textContent = '还没有卡片';
    stackEl.appendChild(empty);
    stackEl.classList.remove('has-more');
    return;
  }
  // 堆叠收起时把"当前有意义的那张"排最前面，露出来的不是随便一张
  const ordered = [...items].sort((a, b) => {
    if (exclusive) return (a.id === currentProfileId ? -1 : b.id === currentProfileId ? 1 : 0);
    return (a.enabled === b.enabled) ? 0 : (a.enabled ? -1 : 1);
  });
  for (const item of ordered) {
    stackEl.appendChild(exclusive ? buildProfileCard(item) : buildPromptCard(item));
  }
  stackEl.classList.toggle('collapsed', !!stackState[category]);
  stackEl.classList.toggle('has-more', items.length > 1);
}

function renderAllCards() {
  renderCardStack('profiles', true);
  renderCardStack('ai_persona', false);
  renderCardStack('user_persona', false);
  renderCardStack('long_term_memory', false);
  renderCardStack('other', false);
  renderCardStack('hint', false);
}

// 组标题（"配置槽位"/"AI 人设"这些字）本身也能点，展开/收起整组——
// 比只靠卡片内部那条细标题栏更好按中，尤其是触屏
document.querySelectorAll('.card-group').forEach((groupEl) => {
  const stackEl = groupEl.querySelector('.card-stack');
  const titleSpan = groupEl.querySelector('.card-group-title');
  if (!stackEl || !titleSpan) return;
  titleSpan.style.cursor = 'pointer';
  titleSpan.addEventListener('click', () => {
    const cat = stackEl.dataset.stack;
    if (!stackEl.classList.contains('has-more')) return;
    const collapsed = stackEl.classList.toggle('collapsed');
    stackState[cat] = collapsed;
  });
});

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
      if (category in stackState) stackState[category] = false;
      await load();
      setStatus('已新建卡片，写好内容记得保存');
    } catch (e) {
      setStatus('新建失败: ' + e.message, true);
    }
  });
});

$('addProfile').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新配置' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '创建失败');
    currentProfileId = out.profile.id;
    stackState.profiles = false;
    await load();
    setStatus('已新建配置，填好后记得保存');
  } catch (e) {
    setStatus('新建失败: ' + e.message, true);
  }
});

async function load() {
  try {
    const res = await fetch('/api/settings');
    data = await res.json();
    if (currentProfileId == null || !data.profiles.some((p) => p.id === currentProfileId)) {
      currentProfileId = data.activeProfileId;
    }

    $('maxTokens').value = data.maxTokens || 280;
    renderAllCards();
    $('speed').value = data.speed || 6;
    fontPills.setActive(data.font || 'pinyon');

    const theme = data.theme || 'white';
    themePills.setActive(theme);
    bgColorHex = data.bgColor || '#ffffff';
    applyTheme(theme, bgColorHex);
    syncBgPickerVisibility(theme);
    bgColorPicker.setHex(bgColorHex);
    applyThemeColor(data.themeColor || '#000000');
    themeColorPicker.setHex(data.themeColor || '#000000');

    const chromeTheme = data.chromeTheme || 'day';
    chromeThemePills.setActive(chromeTheme);
    const chromeDefaults = CHROME_PRESETS[chromeTheme] || CHROME_PRESETS.day;
    chromeInkHex = data.chromeInk || chromeDefaults.ink;
    chromeBoxHex = data.chromeBox || chromeDefaults.box;
    chromeBoxAlpha = typeof data.chromeBoxAlpha === 'number' ? data.chromeBoxAlpha : chromeDefaults.alpha;
    applyChromeTheme(chromeInkHex, chromeBoxHex, chromeBoxAlpha);
    chromeBoxColorPicker.setHex(chromeBoxHex);
    chromeInkColorPicker.setHex(chromeInkHex);
    $('chromeBoxAlpha').value = chromeBoxAlpha;
    syncChromeCustomVisibility(chromeTheme);

    const glassIntensity = data.glassIntensity || 'standard';
    glassPills.setActive(glassIntensity);
    applyGlassIntensity(glassIntensity);

    cjkFontPills.setActive(data.cjkFont || 'default');
    $('cjkFontCustomPill').textContent = data.hasCjkFont ? (data.cjkFontName || '自定义字体') : '上传字体文件';

    const customPill = $('customThemePill');
    if (data.hasCustomBackground) {
      customPill.style.backgroundImage = `url(/api/background-image?t=${Date.now()})`;
      customPill.classList.add('has-image');
      customPill.textContent = '';
    } else {
      customPill.style.backgroundImage = '';
      customPill.classList.remove('has-image');
      customPill.textContent = '上传图片';
    }

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

$('bgFile').addEventListener('change', async () => {
  const file = $('bgFile').files[0];
  if (!file) return;
  const customPill = $('customThemePill');
  const prevText = customPill.textContent;
  customPill.textContent = '上传中…';
  try {
    const imageDataUrl = await resizeImageToDataUrl(file, 1920, 0.85);
    const res = await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '上传失败');
    themePills.setActive('custom');
    applyTheme('custom', bgColorHex);
    syncBgPickerVisibility('custom');
    customPill.style.backgroundImage = `url(${imageDataUrl})`;
    customPill.classList.add('has-image');
    customPill.textContent = '';
    setStatus('背景图已上传并选中，记得点保存');
  } catch (e) {
    customPill.textContent = prevText;
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
      stackState.long_term_memory = false;
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

async function saveAll() {
  try {
    // 1. 保存所有 API 配置槽位
    const profileEls = document.querySelectorAll('.profile-card');
    await Promise.all(Array.from(profileEls).map((el) => {
      const id = el.dataset.id;
      const body = {
        name: el.querySelector('.field-name').value,
        baseUrl: el.querySelector('.field-baseurl').value,
        model: el.querySelector('.field-model').value,
      };
      const apiKey = el.querySelector('.field-apikey').value.trim();
      if (apiKey) body.apiKey = apiKey;
      return fetch('/api/profiles/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }));

    // 2. 保存所有提示词卡片（标题/内容/开关），堆叠里的和平铺的都用同一个 .prompt-card 类选
    const cardEls = document.querySelectorAll('.prompt-card');
    await Promise.all(Array.from(cardEls).map((el) => {
      const id = el.dataset.id;
      const title = el.querySelector('.field-title').value;
      const content = el.querySelector('.field-content').value;
      const enabled = el.querySelector('.field-enabled').checked;
      return fetch('/api/cards/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, enabled }),
      });
    }));

    // 3. 保存全局设置 + 把当前选中的配置设为使用中
    const font = fontPills.getActive() || 'pinyon';
    const theme = themePills.getActive() || 'white';
    const gRes = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxTokens: parseInt($('maxTokens').value, 10) || 280,
        speed: parseInt($('speed').value, 10) || 6,
        font,
        theme,
        themeColor: themeColorHex,
        bgColor: bgColorHex,
        chromeTheme: chromeThemePills.getActive() || 'day',
        chromeInk: chromeInkHex,
        chromeBox: chromeBoxHex,
        chromeBoxAlpha: chromeBoxAlpha,
        glassIntensity: glassPills.getActive() || 'standard',
        cjkFont: cjkFontPills.getActive(),
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
}

form.addEventListener('submit', (e) => { e.preventDefault(); saveAll(); });
$('save').addEventListener('click', saveAll);

const themeColorPicker = setupColorPicker({
  ids: {
    panel: 'theme-color-panel', sv: 'theme-color-sv', hue: 'theme-color-hue', wheel: 'theme-color-wheel',
    modeSquare: 'theme-color-mode-square', preview: 'theme-color-preview', hex: 'theme-color-hex', customBtn: 'btn-theme-custom-color',
  },
  presetsSelector: '#theme-color-presets .color-swatch[data-color]',
  getInitial: () => themeColorHex,
  onChange: applyThemeColor,
  statusMsg: '主题色已更新，记得点保存',
});
const bgColorPicker = setupColorPicker({
  ids: {
    panel: 'bg-color-panel', sv: 'bg-color-sv', hue: 'bg-color-hue', wheel: 'bg-color-wheel',
    modeSquare: 'bg-color-mode-square', preview: 'bg-color-preview', hex: 'bg-color-hex', customBtn: 'btn-bg-custom-color',
  },
  presetsSelector: '#bg-color-presets .color-swatch[data-color]',
  getInitial: () => bgColorHex,
  onChange: (hex) => { bgColorHex = hex; applyTheme('solid', hex); },
  statusMsg: '背景色已更新，记得点保存',
});
const fontPills = setupOptionPills('font');
const themePills = setupOptionPills('theme', (value) => {
  applyTheme(value, bgColorHex);
  syncBgPickerVisibility(value);
}); // 点了就实时预览纸张背景
const cjkFontPills = setupCjkFontPills();

const chromeBoxColorPicker = setupColorPicker({
  ids: {
    panel: 'chrome-box-color-panel', sv: 'chrome-box-color-sv', hue: 'chrome-box-color-hue', wheel: 'chrome-box-color-wheel',
    modeSquare: 'chrome-box-color-mode-square', preview: 'chrome-box-color-preview', hex: 'chrome-box-color-hex', customBtn: 'btn-chrome-box-custom-color',
  },
  presetsSelector: '#chrome-box-presets .color-swatch[data-color]',
  getInitial: () => chromeBoxHex,
  onChange: (hex) => applyChromeTheme(chromeInkHex, hex, chromeBoxAlpha),
  statusMsg: '界面底色已更新，记得点保存',
});
const chromeInkColorPicker = setupColorPicker({
  ids: {
    panel: 'chrome-ink-color-panel', sv: 'chrome-ink-color-sv', hue: 'chrome-ink-color-hue', wheel: 'chrome-ink-color-wheel',
    modeSquare: 'chrome-ink-color-mode-square', preview: 'chrome-ink-color-preview', hex: 'chrome-ink-color-hex', customBtn: 'btn-chrome-ink-custom-color',
  },
  presetsSelector: '#chrome-ink-presets .color-swatch[data-color]',
  getInitial: () => chromeInkHex,
  onChange: (hex) => applyChromeTheme(hex, chromeBoxHex, chromeBoxAlpha),
  statusMsg: '文字/边框颜色已更新，记得点保存',
});
$('chromeBoxAlpha').addEventListener('input', () => {
  applyChromeTheme(chromeInkHex, chromeBoxHex, parseFloat($('chromeBoxAlpha').value));
});
const chromeThemePills = setupOptionPills('chromeTheme', (value) => {
  syncChromeCustomVisibility(value);
  if (value === 'custom') {
    applyChromeTheme(chromeInkHex, chromeBoxHex, chromeBoxAlpha);
    return;
  }
  const p = CHROME_PRESETS[value];
  applyChromeTheme(p.ink, p.box, p.alpha);
  chromeBoxColorPicker.setHex(p.box);
  chromeInkColorPicker.setHex(p.ink);
  $('chromeBoxAlpha').value = p.alpha;
}); // 点了就实时预览
const glassPills = setupOptionPills('glassIntensity', applyGlassIntensity); // 点了就实时预览

load();
setupSectionNav();
