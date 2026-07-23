# 墨问 · ebook-handwriting-diary

> **用笔在电子书屏幕上写字，停几秒，日记会用一手手写体一笔笔回答你——像一本会回应你的魔法日记。**

写在电子墨水屏（BOOX / reMarkable / iPad）上的字会像墨水被纸吸走一样淡去，然后一个博学又冷幽默的"墨先生"用流畅的手写体浮现回答，再慢慢淡去。复刻自 reMarkable Paper Pro 上的 [riddle](https://github.com/MaximeRivest/riddle) 项目，硬件换成更易得的墨水屏平板，软件用网页重写。

---

## 🎉 立即体验

在墨水屏 / iPad / 平板的浏览器打开（用笔或手指直接写）：

### 👉 [**ink-diary.onrender.com**](https://ink-diary.onrender.com)

---

## 📖 怎么用（给普通用户）

### BOOX 墨水屏

1. 在 BOOX 的**浏览器**打开 `https://ink-diary.onrender.com`
2. 点浏览器**菜单**（⋮）→ **添加到主屏幕**
3. 回桌面，点新生成的"墨"字图标，**全屏打开**
4. **等 10–20 秒**让页面加载完（首次打开字体较大，出现"用笔在这里写点什么…"的提示后就可以写了）
5. 用笔在屏幕上写字，**停几秒**，字被吸走，回答浮现
6. 回答停留几秒后自动淡去，可以写下一个问题

### iPad

1. 用 **Safari** 打开 `https://ink-diary.onrender.com`
2. 点**分享按钮**（方框↑）→ **添加到主屏幕** → 添加
3. 桌面点"墨"字图标全屏打开，用 Apple Pencil 或手指写

> **提示**：第一次打开较慢（字体下载），从主屏幕图标第二次打开会快很多。

---

## 🧙 它是怎么工作的

```
笔迹(压感) → 画墨迹 → 停笔几秒 → 截图存PNG
        ↓
发给视觉大模型(读你的手写) → 流式输出回答
        ↓
回答用手写字体渲染 → Zhang-Suen 细化成单像素笔迹
        ↓
逐笔在屏幕上"写"出来 → 停留 → 淡去
```

- **笔迹采集**：Pointer Events + 压感，支持电磁笔 / Apple Pencil / 手指
- **AI 识图回答**：调用视觉大模型读你的手写，按"墨先生"人设（冷幽默 + 博学）回应
- **手写动画**：用霞鹜文楷渲染文字 → Zhang-Suen 骨架细化 → 按书写顺序逐笔浮现
- **屏幕自适应**：字号 / 留白 / 行数根据屏幕尺寸动态计算，不越界

---

## 🚀 自己部署（给开发者）

想用自己的 API key 跑一份？三步搞定。

### 1. Fork 这个仓库

点右上角 **Fork**，复制到你自己的 GitHub。

### 2. 部署到 Render（免费）

1. 打开 [render.com](https://render.com)，用 GitHub 登录
2. **New +** → **Web Service** → 选你的 `ink-diary` 仓库
3. 照着填：

| 字段 | 填什么 |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

4. **Environment** 里添加环境变量：

| Key | Value |
|---|---|
| `OPENAI_API_KEY` | 你的 API key |
| `OPENAI_BASE_URL` | OpenAI 兼容端点（如 `https://api.openai.com/v1`） |
| `OPENAI_MODEL` | 视觉模型（如 `gpt-4o-mini`） |

5. **Create Web Service**，等 2-3 分钟构建完成

### 3. 打开

部署完成后 Render 会给你一个网址，在任何设备浏览器打开就能用。`git push` 后 Render 自动重新部署。

> **本地运行**：`cd server && cp .env.example .env`（填 key）`&& npm install && npm start`，浏览器打开 `http://localhost:3000/?mouse`（`?mouse` 让鼠标也能写）

---

## 📁 项目结构

```
ink-diary/
├── server/                 # Node + Express 后端
│   ├── persona.js          # "墨先生"人设提示词
│   ├── index.js            # 静态托管 + /interpret 流式转发
│   └── .env.example        # 配置模板
└── web/                    # 前端（浏览器直接加载）
    ├── index.html          # 全屏画布 + PWA manifest
    ├── styles.css          # 纯黑白，墨水屏优化
    ├── fonts/LXGWWenKai.ttf# 霞鹜文楷（中英文手写体）
    ├── lib/perfect-freehand.js
    └── src/
        ├── config.js       # 时序常量 + 屏幕自适应 layout()
        ├── app.js          # 状态机主循环
        ├── ink.js          # 笔迹采集（Pointer Events）
        ├── capture.js      # PNG 生成 + 上传
        ├── oracle.js       # 流式回答解析
        ├── scribe.js       # 手写动画（Zhang-Suen + trace）
        └── dissolve.js     # 哈希溶解淡出
```

## 🔧 技术取舍

- **网页而非原生 App**：开发快、跨设备、换硬件不用重写
- **Zhang-Suen 细化做手写动画**：生成单像素中线笔迹，书写感最真
- **霞鹜文楷**：原版 Dancing Script 无中文字形，文楷开源且适合细化
- **Responses API**：中转站限制，需用 Codex 兼容端点

## 🙏 致谢

核心体验设计来自 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（MIT）。时序常量、状态机、Zhang-Suen 手写管线均移植自该项目。

## 📄 License

MIT
