// 桌面版入口。把 server/ 里的同一套 Express 逻辑跑在本地随机端口(仅监听127.0.0.1，
// 不对外网开放)，然后开一个窗口指过去。设置文件存到系统的用户数据目录，不会因为
// 便携版exe放在只读路径(比如U盘)而写不进去。

const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');

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
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程只通过 fetch 访问本地服务，不需要任何 Node 能力
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
