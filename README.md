<div align="center">

<img src="web/icon.png" width="120" alt="Missive">

# Missive

在屏幕上手写，AI 读完后以手写体回复。

[**下载 Windows 版**](../../releases/latest) · [**下载安卓版**](../../releases/latest) · [**浏览器打开**](https://aeterlilis.github.io/missive/)

</div>

---

## 简介

一块全屏画布，支持鼠标、触屏与手写笔。写完停笔数秒，笔迹淡去，回复随即在纸面上逐笔浮现，停留片刻后散开。界面上只有纸和墨。

## 安装

| 平台 | 方式 |
|---|---|
| Windows | 下载 `Missive-Setup-1.1.0.exe`，双击安装 |
| 安卓手机 / 平板 | 下载 `Missive-1.1.0.apk`，在设备上安装。此文件可直接转发 |
| iPhone / iPad / 其它 | 浏览器打开 [网页版](https://aeterlilis.github.io/missive/)，经菜单「添加到主屏幕」 |

设置与历史按设备各自存储，设备之间不同步。

Windows 版安装至当前用户目录，不需要管理员权限；卸载后数据保留在 `%APPDATA%\Missive`。

安卓版全屏运行，隐藏系统栏。自屏幕顶部下滑可临时唤出状态栏。

## 配置

首次启动需在设置页填写 API 信息。笔迹由 AI 识别，所选模型必须支持图像输入。用量计费在使用者自己的账号下。

| 项 | 说明 |
|---|---|
| 接口规范 | 默认自动识别，可手动指定 |
| API 基础 URL | 形如 `https://xxx.com/v1` |
| API 密钥 | 服务商处获取 |
| 模型 | 须支持图像输入，如 `gpt-4o-mini` |

支持的接口规范：

| 规范 | 适用 |
|---|---|
| OpenAI Chat Completions | DeepSeek、硅基流动、OpenRouter、智谱、Kimi、Ollama、LM Studio 及多数中转 |
| OpenAI Responses | OpenAI 官方及 Codex 中转 |
| Anthropic Messages | Claude 官方 |
| Google Gemini | Gemini 官方 |

可建立多套配置并随时切换。

## 可调项

- **纸张**：宣纸、羊皮纸、皱纸、水彩、纯黑，或自定义图片
- **字体**：五种中文手写体、六种西文花体，或自定义 TTF
- **笔刷**：六种，粗细、笔尖角度与颜色可调，各自记忆
- **时序**：笔迹停留与淡出时长、回复停留与散去时长
- **界面**：主题色、界面底色、玻璃强度、工具栏位置、日夜配色
- **人设**：系统提示词与回应语气可自行编写

历史页保留每轮记录，含当时的纸面截图。

## 常见问题

**Windows 弹出「已保护你的电脑」** — 点「更多信息」，再点「仍要运行」。安装包未做代码签名。

**杀毒软件报毒或自动删除** — 未签名安装包的常见误报。加入白名单，或从回收站还原。每个版本发布前经 Windows Defender 扫描。

**安卓提示「未知来源」** — 按系统提示允许一次即可。

**启动黑屏或长时间无响应** — Windows 版首次启动需加载字体，约十余秒；仍无响应则重启程序。安卓版字体已内置，无此步骤。

**提示「还没配置 API」** — API 信息未填或有误。URL 通常以 `/v1` 结尾。

**回复称字迹看不清** — 字写得过小或过于潦草。也可能是模型不支持图像输入。

**平板可用吗** — 安卓平板直接装 APK；iPad 用网页版。鸿蒙平板经卓易通可安装 APK。

**支持手写笔压感吗** — 支持。钢笔、圆珠笔、马克笔、毛笔的线宽随压力变化，尖笔尤为明显。

**换设备后数据还在吗** — 不在。设置、历史与 API 密钥均不跨设备，需重新配置。

**书写内容会上传吗** — 会发送至所配置的 AI 服务用于生成回复，除此之外不外传。历史仅存于本机。

---

<details>
<summary><b>自行构建</b></summary>

<br>

`web/` 为静态文件，任意静态服务器即可运行；设置与历史存于 IndexedDB，AI 请求由页面直接发出。地址加 `?mouse` 允许鼠标书写。

亦可运行 `server/` 下的 Node 服务（`npm install && npm start`，端口 3000），此时设置与历史存于服务端。页面启动时探测 `/api/health` 决定走哪一套，`?storage=local` 与 `?storage=remote` 可强制指定。

```bash
npm install
npm run dist                              # Windows 安装包 → dist/
npx cap sync android                      # 同步 web/ 至安卓工程
cd android && ./gradlew assembleRelease   # APK → android/app/build/outputs/apk/release/
```

安卓构建需 JDK 21 与 Android SDK（compileSdk 36、build-tools 35）。签名配置位于 `android/keystore.properties`，不在仓库内，缺失时产出未签名包。

前端为无框架的原生 JS。手写动画将字形渲染为位图，经 Zhang-Suen 算法细化为单像素骨架，再沿骨架逐笔描出；笔迹采集走 Pointer Events 与压感；淡出为哈希溶解。桌面版为 Electron，安卓版为 Capacitor 套壳，两者装载同一份 `web/`。

```
web/src/    app.js 状态机 · ink.js 笔迹 · scribe.js 手写动画 · dissolve.js 淡出
            glass.js 玻璃层 · settings.js 设置页 · history.js 历史页
            api.js 数据出入口（api-local.js 本地 / api-remote.js 走服务）
            store.js IndexedDB · shared/ 两端共用的上游请求与设置模型
electron/   桌面版外壳          android/   安卓版原生工程
server/     可选的 Node 服务
```

</details>

---

## 授权与致谢

本项目基于 [yana108/ebook-handwriting-diary](https://github.com/yana108/ebook-handwriting-diary)（MIT）二次开发，该项目复刻自 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（MIT）。时序设计、状态机与手写管线来自这两个项目。

预装字体各自遵循原始授权：霞鹜文楷、寒蝉春风、思源宋体、柳建毛草、钟齐志莽行等为开源字体（SIL OFL 或相应协议），西文花体来自 Google Fonts。

本项目以 MIT 授权发布，详见 [LICENSE](LICENSE)。
