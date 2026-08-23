/* 玻璃质感：写字页/设置页/历史页共用这一份（以前这段在 app.js/settings.js/history.js
   里各抄了一遍，改一次要改三处）。对外只有 applyGlassIntensity(mode) 一个入口。

   "标准"档就是 chrome-theme.css 里那套默认值：一层比较厚的模糊+提饱和，简单可靠。
   "更透亮"档是四件事叠起来的：

   ① 反光（--box-sheen）
      玻璃面本身要反环境光，不然再透也像一张贴纸。一道斜掠过整个面的高光带
      加左上一团柔和光斑，垫在半透明底色 --box-bg 上面。

   ② 边缘光（--box-rim）
      不是只有上边一条，而是左上一道 + 右下一道：光源在左上，右下那道是光穿过
      玻璃从背面折回来的，所以比左上弱一档。另外两个对角（右上/左下）反而压暗一点，
      三者一起才有厚度，只给上边一条白线看起来是平的。

   ③ 更轻的模糊（--box-blur）
      模糊重了就是磨砂不是玻璃。这档只留很轻的一点点，背后的形状还认得出来。

   ④ 边缘倒影（--box-lens，本文件的主要内容）
      真玻璃边缘曲率大，光线在那里被弯得很厉害，会把紧挨着轮廓外面的东西压缩、
      翻转着映到边上——就是 iOS/Android 那种玻璃条底边能看见倒着的字的效果。
      CSS 没有任何属性能做到这个，得靠 SVG 的 feDisplacementMap：给每块玻璃按它
      自己的尺寸和圆角生成一张位移贴图，贴边那一圈把采样点沿轮廓法线往外推，推得
      比往里走得还快，采样顺序就翻过来了，倒影是这么折出来的。见 buildLensMap。
      ④b 另外还有一圈贴着轮廓的高饱和亮边（--box-band-*，规则在 glass.css），
      真玻璃这两样本来就同时存在，叠着用。

   兼容性：Safari / iOS 不支持在 backdrop-filter 里引用 SVG 滤镜（url(#...)），
   而且一旦写进去，整条 backdrop-filter 会连模糊都一起失效，比啥都没有还难看。
   所以 LENS_SUPPORTED 先探测，不支持就根本不设 --box-lens——那些浏览器上
   ①②③④b 照常，只少一个倒影。 */

/* 所有"玻璃"元素。glass.css 里那两条规则（backdrop-filter 和 ::after 亮边）用的是
   同一份名单，两边要一起改。不在名单里的是故意的：
   - body::before 是整页遮罩，铺满视口，给它配透镜没有意义；
   - .card-stack.collapsed.has-more::before/::after 是卡片堆叠的影子，本身就是伪元素，
     没法再挂自己的 ::after。它们照常吃 --box-rim。 */
export const GLASS_SELECTOR = [
  '.icon-btn', '#brush-panel', '.brush-presets button', '.type-actions button',
  'header', '#settings-nav', '.secondary', '.option-pill', '.add-btn',
  '.card', '.conv-card', '.color-mode-tab'
].join(', ');

/* 提饱和是给厚模糊配的：16px 糊下去颜色会被洗淡，得加回来。"更透亮"档的模糊只剩 1.5px，
   背景基本是原样透过来的，没什么可补，再乘 1.5 就是白加——羊皮纸这类本身就浓的背景会被
   推到发荧光。所以两档的倍数差得很远，标准档 1.6、这档只留一点点让玻璃不至于死板。 */
const STANDARD_BLUR = 'blur(16px) saturate(1.6)';

const ENHANCED_BLUR = 'blur(1.5px) saturate(1.12)';

const ENHANCED_RIM = [
  '0 3px 12px rgba(0,0,0,.10)',              // 外投影，浮起来
  'inset 1px 1px 0 rgba(255,255,255,.47)',   // 左上边缘光（迎光面）
  'inset -1px -1px 0 rgba(255,255,255,.27)', // 右下边缘光（背光面，折回来的，弱一档）
  'inset 2px 3px 10px rgba(255,255,255,.14)',
  'inset -2px -3px 10px rgba(255,255,255,.08)',
  'inset -2px 2px 10px rgba(0,0,0,.05)',     // 右上/左下压暗，撑出厚度
  'inset 2px -2px 10px rgba(0,0,0,.05)'
].join(', ');

const ENHANCED_SHEEN = [
  'linear-gradient(135deg, rgba(255,255,255,.04) 0%, rgba(255,255,255,.007) 26%,' +
    ' rgba(255,255,255,0) 46%, rgba(255,255,255,0) 72%, rgba(255,255,255,.012) 100%)',
  'radial-gradient(70% 55% at 26% 16%, rgba(255,255,255,.034), rgba(255,255,255,0) 68%)'
].join(', ');

const ENHANCED_BAND_WIDTH = '2px';
// 亮圈同理，光在边上聚起来主要是"更亮"，不是"更艳"——提饱和给得太狠，浓背景上这一圈会
// 变成一道荧光边。饱和给到能看出是背景色被挤出来就够，剩下的交给亮度。
const ENHANCED_BAND_FILTER = 'saturate(1.7) brightness(1.06)';

// 倒影参数。SCALE 是往外推的最大距离（推得越远倒影越夸张）；THICKNESS 是边缘那圈
// "斜面"有多宽，窄了像薄玻璃片，宽了像玻璃砖；POWER 是斜面的剖面形状，小于 1 表示
// 只有最贴边的一线剧烈弯折、往里迅速收平。
const LENS_SCALE = 90;
const LENS_THICKNESS = 7;
const LENS_POWER = 0.6;

const SVG_NS = 'http://www.w3.org/2000/svg';

export const LENS_SUPPORTED = (() => {
  try { return CSS.supports('backdrop-filter', 'url(#glass-lens) blur(1px)'); } catch { return false; }
})();

/* 位移贴图：跟玻璃块同尺寸的一张图，R 通道存横向偏移、G 通道存纵向偏移，128 表示不动。
   只有贴着轮廓 thickness 那一圈是非中性的，中间一律 128（背景原样透过来，不然整块都会歪）。
   偏移方向取轮廓的外法线，强度用 sqrt(1-t²) 的剖面——贴边最强、往里迅速收敛，正好是
   一个圆角斜面的形状。power 再对这条曲线做一次幂，用来调斜面陡缓。 */
function buildLensMap(width, height, radius) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const halfW = width / 2;
  const halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - halfW;
      const py = y + 0.5 - halfH;
      // 圆角矩形的有符号距离场：先把点折进第一象限，再按"在圆角上/在直边上"分两种情况
      const qx = Math.abs(px) - (halfW - r);
      const qy = Math.abs(py) - (halfH - r);
      let signed, nx, ny;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1;
        signed = len - r;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        signed = qx - r;
        nx = 1;
        ny = 0;
      } else {
        signed = qy - r;
        nx = 0;
        ny = 1;
      }
      if (px < 0) nx = -nx;
      if (py < 0) ny = -ny;

      const depth = -signed; // 到轮廓的距离，正数表示在玻璃里面
      let strength = 0;
      if (depth >= 0 && depth < LENS_THICKNESS) {
        const t = depth / LENS_THICKNESS;
        strength = Math.pow(Math.sqrt(Math.max(0, 1 - t * t)), LENS_POWER);
      }

      const i = (y * width + x) * 4;
      data[i] = Math.round(255 * (0.5 + nx * strength * 0.5));
      data[i + 1] = Math.round(255 * (0.5 + ny * strength * 0.5));
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

// 同尺寸同圆角的元素（一排图标按钮、一列卡片）共用一个滤镜，不用一人生成一张贴图
const lensCache = new Map();
let lensHost = null;

function lensContainer() {
  if (!lensHost) {
    lensHost = document.createElementNS(SVG_NS, 'svg');
    lensHost.setAttribute('width', '0');
    lensHost.setAttribute('height', '0');
    lensHost.setAttribute('aria-hidden', 'true');
    lensHost.style.cssText = 'position:absolute;pointer-events:none';
    document.body.appendChild(lensHost);
  }
  return lensHost;
}

function svgNode(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

function lensFilterId(width, height, radius) {
  const key = `${width}|${height}|${radius}`;
  const cached = lensCache.get(key);
  if (cached) return cached;

  const id = `glass-lens-${lensCache.size}`;
  // filterUnits/primitiveUnits 都用 userSpaceOnUse：坐标就是元素边框盒的 CSS 像素，
  // 贴图才能跟元素严丝合缝地对上。sRGB 是必须的，默认的 linearRGB 会把贴图里的
  // 128（不动）算歪，整块背景会偏。
  const filter = svgNode('filter', {
    id,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    x: 0, y: 0, width, height,
    'color-interpolation-filters': 'sRGB'
  });
  const map = svgNode('feImage', {
    x: 0, y: 0, width, height,
    preserveAspectRatio: 'none',
    result: 'lensmap'
  });
  map.setAttribute('href', buildLensMap(width, height, radius));
  filter.appendChild(map);
  filter.appendChild(svgNode('feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'lensmap',
    scale: LENS_SCALE,
    xChannelSelector: 'R',
    yChannelSelector: 'G'
  }));
  lensContainer().appendChild(filter);
  lensCache.set(key, id);
  return id;
}

function cornerRadius(node, width, height) {
  const raw = getComputedStyle(node).borderTopLeftRadius;
  const value = parseFloat(raw) || 0;
  // border-radius: 50% 这类百分比在计算值里还是百分比，换算成像素再交给贴图
  return raw.endsWith('%') ? Math.min(width, height) * (value / 100) : value;
}

function mountLenses() {
  for (const node of document.querySelectorAll(GLASS_SELECTOR)) {
    const width = Math.round(node.offsetWidth);
    const height = Math.round(node.offsetHeight);
    if (!width || !height) {
      node.style.removeProperty('--box-lens');
      continue;
    }
    const radius = Math.round(cornerRadius(node, width, height));
    node.style.setProperty('--box-lens', `url(#${lensFilterId(width, height, radius)})`);
  }
}

function unmountLenses() {
  for (const node of document.querySelectorAll(GLASS_SELECTOR)) {
    node.style.removeProperty('--box-lens');
  }
}

// 元素尺寸变了（转屏、卡片展开）或者页面新插了玻璃元素（历史记录列表、设置里的卡片）
// 都得重新配一次贴图。合并成一次延迟执行，免得一串 DOM 变动触发几十次重算。
let refreshTimer = 0;
let watching = false;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(mountLenses, 120);
}

function startWatching() {
  if (watching) return;
  watching = true;
  window.addEventListener('resize', scheduleRefresh);
  // 只看子节点增删：属性变化不看，否则 mountLenses 自己写的内联 style 会把自己再触发一遍
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
}

/* 玻璃强度：'enhanced' = 更透亮档，其余（'standard' 和没设过的）走 chrome-theme.css 的默认值。
   三个页面拉到设置后各自调一次，设置页里换档也调。 */
export function applyGlassIntensity(mode) {
  const root = document.documentElement.style;
  if (mode !== 'enhanced') {
    root.setProperty('--box-blur', STANDARD_BLUR);
    root.setProperty('--box-rim', 'none');
    root.setProperty('--box-sheen', 'none');
    root.setProperty('--box-band-w', '0px');
    root.setProperty('--box-band-filter', 'none');
    unmountLenses();
    return;
  }
  root.setProperty('--box-blur', ENHANCED_BLUR);
  root.setProperty('--box-rim', ENHANCED_RIM);
  root.setProperty('--box-sheen', ENHANCED_SHEEN);
  root.setProperty('--box-band-w', ENHANCED_BAND_WIDTH);
  root.setProperty('--box-band-filter', ENHANCED_BAND_FILTER);
  if (!LENS_SUPPORTED) return;
  mountLenses();
  startWatching();
}
