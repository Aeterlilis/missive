// 一轮对话怎么组、AI 吐回来的东西怎么收。后端和手机版共用同一份。
//
// 这里放的是"跟谁说话都一样"的部分：历史怎么摊成上下文、几段固定提示词、
// 「磨合」那次回答怎么解析。请求发成什么形状归 ./providers.js，怎么发出去归 ./upstream.js。
//
// 只用标准 JS，不许碰 fs/Buffer/process。

// 附加在打字模式请求里的提示。人设卡片默认是围绕"看图读墨迹"写的（"如果字迹潦草……
// 看不清就说看不清"），打字模式没有图片，不补这一句 AI 容易莫名其妙地说"看不清"。
export const TYPED_MODE_NOTE = '（提示：这一次对方是直接打字发给你的，不是手写照片，正常回应文字内容即可，不要说"看不清"、"字迹模糊"之类只适用于图片的话。）';

export const SUMMARY_PROMPT = '请把以上这些互动内容总结成一段简短的长期记忆备注，帮助你以后回忆起对方是谁、聊过什么、有什么值得记住的事或偏好。控制在150字以内，不分点、不用markdown，就写成一段随手记的备注。';

// 把历史记录摊成中立请求里的一轮轮对话（用户那半 + AI回复那半）。
// 手写来的那半是图，打字来的那半是文字。
export function buildContextTurns(entries) {
  return entries.flatMap((entry) => [
    {
      role: 'user',
      parts: entry.kind === 'typed'
        ? [{ type: 'text', text: entry.userText || '' }]
        : [{ type: 'image', dataUrl: entry.imageDataUrl }],
    },
    { role: 'assistant', parts: [{ type: 'text', text: entry.reply }] },
  ]);
}

// ─── 「磨合」：让 AI 照当前人设把彩蛋文案写一遍 ─────
// 设置页那个按钮按一下走这里，一次一个请求——故意没绑在保存人设上，
// 免得改个错别字就悄悄花掉一次调用。
// 生成结果不回给页面展示：这是彩蛋，内容只能靠一下下戳出来。写砸了就再按一次。
export const ATTUNE_TASK = [
  '下面这件事跟平时的对话无关，请照你上面的人设完成它。你要写两组短句，都是你自己会说的话。',
  '',
  '【第一组：被反复戳时的反应】',
  '对方会反复戳你的头像，就像戳一个人的肩膀。第一下和第七下，任何人的反应都不会一样。',
  '写五档，一档比一档情绪更重，每档三条备选（随机抽一条显示）。',
  '第一档几乎没什么反应，第五档已经拿对方没办法了。',
  '',
  '【第二组：三种意外情况下的托辞】',
  '这个应用里，对方手写一页纸给你，你读完手写回复。偶尔会出岔子，这时要由你开口说一句。',
  '三种情况各写三条备选：',
  '- unreadable：这一页你没能读出来。（对方的字迹、或者别的什么原因，按你的性格挑一个说法）',
  '- distracted：等太久了，这一轮算是错过了。',
  '- blank：话到嘴边什么都没有，得请对方再写一遍。',
  '',
  '【共同要求】',
  '- 每条都很短，最多十几个字，是脱口而出的一句，不是完整对白。',
  '- 用第一人称，就是你在说话；不要描写动作，不要加引号、编号或任何前缀。',
  '- 第二组三种都要能让对方明白"这次没成，可以再来一次"，别只顾着有情绪。',
  '- 只输出一个 JSON 对象，不要解释，不要代码块标记。',
  '',
  '格式（内容全部换成你自己的）：',
  '{"poke":[["嗯？","在。","怎么了"],["又戳。","还在。","有事？"],["…","你很闲。","别戳了。"],'
    + '["……","随你吧。","我不动了。"],["你赢了。","我认输。","随便你戳。"]],'
    + '"unreadable":["墨迹晕开了，我读不出来。","这页我认不全。","字太赶了，我跟不上。"],'
    + '"distracted":["我走神了，能再说一遍吗？","刚才没接住，再来一次。","这一轮我错过了。"],'
    + '"blank":["风把字吹散了，再写一遍吧。","我这儿是空的，你再来一次。","什么都没剩下，重来。"]}',
].join('\n');

const FALLBACK_KINDS = ['unreadable', 'distracted', 'blank'];

// 一句一句地洗：去掉模型爱加的引号、编号、项目符号，过长的截断。
function cleanLines(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim()
      .replace(/^[-*\d.、)\s]+/, '')
      .replace(/^["“”'']+|["“”'']+$/g, '')
      .slice(0, 40))
    .filter(Boolean);
  return out.length ? out : null;
}

// 把模型吐出来的东西解析成 { poke, fallback }。模型很爱多说两句、裹一层代码块，
// 所以先把第一个 { 到最后一个 } 之间截出来再解析。
// 也兼容早期那版只返回一个裸数组（纯五档）的形状——那会儿提示词就是那么写的。
export function parseAttuneResult(text) {
  const raw = String(text || '');
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  let parsed = null;
  if (objStart >= 0 && objEnd > objStart) {
    try { parsed = JSON.parse(raw.slice(objStart, objEnd + 1)); } catch { parsed = null; }
  }
  if (!parsed) {
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart < 0 || arrEnd <= arrStart) return null;
    try { parsed = { poke: JSON.parse(raw.slice(arrStart, arrEnd + 1)) }; } catch { return null; }
  }

  // 五档：必须齐齐整整五档、每档至少一条，差一点就整个不要——递进缺一环就垮了
  let poke = null;
  if (Array.isArray(parsed.poke) && parsed.poke.length === 5) {
    const tiers = parsed.poke.map(cleanLines);
    if (tiers.every(Boolean)) poke = tiers;
  }

  // 三种托辞彼此独立，谁能用收谁，剩下的继续用内置那份
  const fallback = {};
  for (const kind of FALLBACK_KINDS) {
    const lines = cleanLines(parsed[kind]);
    if (lines) fallback[kind] = lines;
  }

  if (!poke && !Object.keys(fallback).length) return null;
  return { poke, fallback: Object.keys(fallback).length ? fallback : null };
}
