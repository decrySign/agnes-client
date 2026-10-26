const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agnesDesktop", {
  pickFolder: (opts) => ipcRenderer.invoke("pick-folder", opts),
  saveSecret: (apiKey) => ipcRenderer.invoke("save-secret", apiKey),
  deviceHash: () => ipcRenderer.invoke("device-hash"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
});
