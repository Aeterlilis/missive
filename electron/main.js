// 桌面版入口。把 server/ 里的同一套 Express 逻辑跑在本地随机端口(仅监听127.0.0.1，
// 不对外网开放)，然后开一个窗口指过去。设置文件存到系统的用户数据目录，不会因为
// 便携版exe放在只读路径(比如U盘)而写不进去。

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');

// 系统字体扫描——只给"从系统字体库选中文手写字体"这一个功能用，
// 白名单限定在这两个目录，read-font-file 也只认这两个目录下的路径，别的一律拒绝
const SYSTEM_FONT_DIRS = [
  'C:\\Windows\\Fonts',
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'),
];

function listFontsInDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
      .map((f) => ({ name: f.replace(/\.(ttf|otf|ttc)$/i, ''), path: path.join(dir, f) }));
  } catch {
    return [];
  }
}

function isAllowedFontPath(filePath) {
  const normalized = path.normalize(filePath).toLowerCase();
  return SYSTEM_FONT_DIRS.some((d) => normalized.startsWith(path.normalize(d).toLowerCase()));
}

ipcMain.handle('list-system-fonts', () => {
  const all = SYSTEM_FONT_DIRS.flatMap(listFontsInDir);
  const seen = new Set();
  return all
    .filter((f) => { if (seen.has(f.name)) return false; seen.add(f.name); return true; })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
});

ipcMain.handle('read-font-file', (event, filePath) => {
  if (typeof filePath !== 'string' || !isAllowedFontPath(filePath)) {
    throw new Error('不允许读取这个路径');
  }
  const buf = fs.readFileSync(filePath);
  return { base64: buf.toString('base64'), filename: path.basename(filePath) };
});

// 必须在 require('../server') 之前设置，settings.js 读取这个环境变量决定存哪
process.env.SETTINGS_DIR = app.getPath('userData');

const { start } = require('../server');

let mainWindow = null;
let httpServer = null;

function createWindow(port) {
  Menu.setApplicationMenu(null); // 去掉菜单栏，更像一个正经App而不是开发者工具

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: 'Missive',
    icon: path.join(__dirname, '../web/icon.png'), // build/icon.ico 只给 electron-builder 打包exe用，运行时窗口图标走这份（web/ 会被打进包里，build/ 不会）
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程主要靠 fetch 访问本地服务；preload 只额外开了个窄口子，
      // 给设置页"从系统字体库选字体"这一个功能用（见 preload.js）
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // port 0 = 系统分配一个空闲端口；只绑 127.0.0.1，不对局域网开放
  httpServer = start(0, '127.0.0.1');
  httpServer.on('listening', () => {
    const port = httpServer.address().port;
    createWindow(port);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && httpServer) {
      createWindow(httpServer.address().port);
    }
  });
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});
