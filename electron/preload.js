// 预加载脚本：只暴露"列出系统字体"和"读某个字体文件"这两个窄接口给网页用，
// 不开 nodeIntegration，网页本身依然拿不到任意 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  listSystemFonts: () => ipcRenderer.invoke('list-system-fonts'),
  readFontFile: (filePath) => ipcRenderer.invoke('read-font-file', filePath),
});
