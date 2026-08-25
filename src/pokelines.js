// pokelines.js —— 应用替 AI 说的那些话：戳图标时的反应，以及出岔子时的托辞。
//
// 这两组的共同点是"该由 AI 开口，但没有真的问过 AI"。写死一套所有人都一样的，
// 刻薄的人设也只会温吞地说"墨迹晕开了"，跟它平时的语气对不上。所以设置页里
// 「磨合」那颗按钮一次请求把两组都按当前人设重新生成，存进设置；没生成过就用
// 这里内置的兜底。
//
// ─── 第一组：戳图标时换出来的那句话 ───
//
// 跟首屏提示语（设置里的 hint 卡片，每天随机一条）是**两个不同的池子**，机制也不一样：
// 首屏那条是打招呼，戳出来的这些是被反复打扰之后的反应，一个人不可能两种场合说同样的话。
//
// 节奏：一档要戳好几下才升下一档——这一档自己那几句话说完了，才轮到下一档。
// 五档全说完之后回到最开始那条招呼语，然后**就不再有反应了**：再怎么戳，写出来的
// 还是那条招呼语。它不是绕回去重来一轮，是真的不理你了。想重新开始只能重开页面。
//
// 一档之内不重样：进这档时把这档的话洗一遍牌，一次说一句，说完为止。这样"越戳越
// 不耐烦"是看得出来的，而不是在同一档里反复抽到同一句让人以为卡住了。
//
// 这些话**不出现在设置页里**：明目张胆列成配置项就不叫彩蛋了，而且不同人设本来就该有
// 不同反应，手写死的池子做不到。下面这套是兜底，保证任何人戳都有东西看；设置页里
// AI 人设卡下面那个按钮按一下，就会让 AI 照当前人设重写一套，把这套替换掉。

// 兜底的五档。没有人设可依据，所以写得克制、不带具体性格。
export const DEFAULT_POKE_LINES = [
  ['嗯？', '在。', '怎么了'],
  ['又戳了一下。', '还在。', '有事？'],
  ['你不写点什么吗。', '笔一直举着呢。', '纸都铺好了。'],
  ['……', '你就是想看它动。', '好吧，再来一次。'],
  ['今天很闲。', '墨要干了。', '你赢了。'],
];

export const POKE_TIERS = DEFAULT_POKE_LINES.length;

export class PokeSequence {
  constructor(pools) {
    this.setPools(pools);
    this.reset();
  }

  // pools 形状不对就退回兜底那套。AI 生成的内容是从接口来的，不能假定它一定规整。
  setPools(pools) {
    const ok = Array.isArray(pools)
      && pools.length === POKE_TIERS
      && pools.every((p) => Array.isArray(p) && p.length > 0 && p.every((s) => typeof s === 'string' && s.trim()));
    this.pools = ok ? pools.map((p) => p.map((s) => s.trim())) : DEFAULT_POKE_LINES;
    this.reset();
  }

  reset() {
    this.tier = 0;
    this.finished = false;   // 五档说完了，之后戳都不再换话
    this._queue = this._shuffled(0);
  }

  // 这一档还剩几句没说（调试/验证用）
  get remaining() { return this._queue.length; }

  _shuffled(tier) {
    const pool = (this.pools[tier] || []).slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
  }

  // 戳一下要显示什么。三种结果：
  //   { kind: 'line', text, tier } —— 换成这一句
  //   { kind: 'greeting' }         —— 五档说完了，写回最开始那条招呼语
  //   { kind: 'silent' }           —— 已经不理人了，内容不变
  next() {
    if (this.finished) return { kind: 'silent' };
    if (this._queue.length === 0) {
      this.tier += 1;
      if (this.tier >= this.pools.length) {
        this.finished = true;
        return { kind: 'greeting' };
      }
      this._queue = this._shuffled(this.tier);
    }
    return { kind: 'line', text: this._queue.shift(), tier: this.tier };
  }
}

// ─── 第二组：出岔子时的托辞 ───
//
// 三种情况在代码里是分开的，语气也该分开——把责任推给纸、推给自己、还是推给"什么都没剩下"，
// 是三件不同的事。内置这套写得中性，AI 生成的那套会按人设整体换掉。
//
// 注意：这三种触发的其实都是技术故障（请求失败 / 超时 / 流是空的），不是真的"字太潦草"。
// 但这个应用从一开始就选择用"它自己的说法"来讲这些故障，而不是弹一个报错框——
// 所以措辞可以有情绪，但必须让人明白"这次没成，可以再来一次"。
export const DEFAULT_FALLBACKS = {
  unreadable: ['墨迹晕开了……我一时读不出来。'],
  distracted: ['……我走神了，能再说一遍吗？'],
  blank: ['……风把字吹散了，能再写一遍吗？'],
};

export class FallbackLines {
  constructor(pools) { this.setPools(pools); }

  // 三种各自独立地校验：AI 只写好了其中一两种，剩下的继续用内置那份，
  // 不因为一处不合格就整套退回去。
  setPools(pools) {
    this.pools = { ...DEFAULT_FALLBACKS };
    if (pools && typeof pools === 'object') {
      for (const kind of Object.keys(DEFAULT_FALLBACKS)) {
        const list = pools[kind];
        if (Array.isArray(list)) {
          const clean = list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
          if (clean.length) this.pools[kind] = clean;
        }
      }
    }
    this._last = {};
  }

  pick(kind) {
    const pool = this.pools[kind] || DEFAULT_FALLBACKS[kind] || [''];
    let line = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && line === this._last[kind]) {
      line = pool[(pool.indexOf(line) + 1) % pool.length];  // 别连着说同一句
    }
    this._last[kind] = line;
    return line;
  }
}
