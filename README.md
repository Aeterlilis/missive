# 墨问 (ink-diary)

> 用笔在墨水屏上写字，停笔几秒后字迹被"纸吸走"，AI 以冷幽默博学者的口吻、用一手手写体一笔笔浮现回答——再慢慢淡去。像一本会回应你的魔法日记。

复刻自 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（reMarkable Paper Pro 上的"汤姆·里德尔日记"），把硬件换成更易得的 **Boox 墨水屏平板**，用 **网页应用** 重写整套软件。

## 它怎么工作

```
电磁笔(压感) → 画墨迹 → 停笔 2.8s → 整页存成 PNG
        ↓
发给后端 → 转给视觉大模型(流式输出回答)
        ↓
回答用「霞鹜文楷」渲染 → Zhang-Suen 细化成单像素中线
        ↓
逐笔在墨水屏上"写"出来(低帧刷新) → 停留 → 淡出
```

## 硬件清单（Boox 路线）

| # | 东西 | 推荐型号 | 大概价格 | 说明 |
|---|---|---|---|---|
| 1 | 墨水屏平板 | **Boox Go 10.3**（首选）或 Note Air3 / Tab 系列 | $249–449 | 自带真实压感笔 |
| 2 | 电磁笔 | Boox 标配 | 含在内 | 4096 级压感，免充电配对 |
| 3 | 大模型 API key | OpenAI / OpenRouter / Groq 任一 | 按量，约几毛钱一次 | 要能识图的视觉模型 |
| 4 | 一台电脑当后端 | 你现有的即可 | $0 | 跑 Node 服务，托管 key + 渲染 |

> Tab 系列带 BSR 高刷，手写更顺但更贵。Go 10.3 是纯墨水屏、轻、性价比高。

## 快速开始

### 1. 后端（你的电脑上）

```bash
cd server
cp .env.example .env
# 编辑 .env，填入你的 API key、模型名
npm install
npm start
```

服务会监听 `0.0.0.0:3000`，同时托管网页 + `/interpret` 接口。

### 2. 前端（Boox 上）

1. 在电脑上跑 `ifconfig | grep inet`（macOS）或 `ipconfig`（Windows）找到局域网 IP，比如 `192.168.1.50`
2. 在 Boox 浏览器打开 `http://192.168.1.50:3000`
3. 菜单 → **添加到主屏幕**（manifest 会让它全屏运行）
4. 用笔在屏上写字，停笔几秒，看日记回应你

> 不需要装 app、不需要配对、不需要外网（除调用大模型 API 外）。

## 调试

- **电脑浏览器也能用**：打开 `http://localhost:3000`，用鼠标/触控板模拟笔（把 `ink.js` 的 `pointerType` 过滤临时放宽到 `'mouse'`）。
- **后端验证**：`curl -X POST http://localhost:3000/interpret -F "image=@test.png"` 看流式输出。
- **Boox 调试清单**：见 [docs/boox-调试清单.md](docs/boox-调试清单.md)

## 项目结构

```
ink-diary/
├── README.md               ← 你在这里
├── docs/                   ← 设计文档、调试清单
├── server/                 ← Node + Express 后端
│   ├── persona.js          ← "墨先生"人设提示词
│   ├── index.js            ← 静态托管 + /interpret 流式转发
│   └── .env.example
└── web/                    ← 前端（Boox 浏览器加载）
    ├── index.html
    ├── manifest.json
    ├── styles.css
    ├── fonts/              ← 霞鹜文楷
    ├── lib/                ← perfect-freehand（离线副本）
    └── src/
        ├── config.js       ← 所有时序常量
        ├── app.js          ← 状态机主循环
        ├── ink.js          ← 笔迹采集
        ├── capture.js      ← PNG 生成 + 上传
        ├── oracle.js       ← 流式回答解析
        ├── scribe.js       ← 手写动画（核心魔法）
        └── dissolve.js     ← 哈希溶解淡出
```

## 技术取舍

- **网页而非安卓原生 App**：开发快、电脑/手机能直接测、换硬件不用重写。Boox 浏览器是 Chromium/WebView，Pointer Events + 压感 + canvas 全支持。
- **Zhang-Suen 细化做手写动画**：生成单像素中线笔迹，书写感最接近原版；SVG 描的是字形外轮廓，看起来像在画轮廓而非写字。
- **霞鹜文楷而非 Dancing Script**：原版字体没有中文字形。文楷开源、覆盖中英文、字形偏细利于细化。
- **第一版不带记忆功能**（riddle 的翻页召回）：先把单轮体验做完整，记忆作为后续增强。

## 致谢

核心体验设计来自 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（MIT）。本项目的时序常量、状态机流程、Zhang-Suen 手写管线均移植自该项目，替换了硬件层（reMarkable evdev/framebuffer → Boox 浏览器 Pointer Events/canvas）。
