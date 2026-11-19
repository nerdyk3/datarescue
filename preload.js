'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // dialogs / util
  pickSource: () => ipcRenderer.invoke('pick-source'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  stop: () => ipcRenderer.invoke('stop'),

  // carving
  carveScan: (source) => ipcRenderer.invoke('carve-scan', source),
  carveRecover: (args) => ipcRenderer.invoke('carve-recover', args),

  // trash
  trashList: () => ipcRenderer.invoke('trash-list'),
  trashRestore: (args) => ipcRenderer.invoke('trash-restore', args),

  // folder
  folderScan: (args) => ipcRenderer.invoke('folder-scan', args),
  folderCopy: (args) => ipcRenderer.invoke('folder-copy', args),

  // android
  androidStatus: () => ipcRenderer.invoke('android-status'),
  androidScan: (args) => ipcRenderer.invoke('android-scan', args),
  androidPull: (args) => ipcRenderer.invoke('android-pull', args),

  // ios
  iosBackups: () => ipcRenderer.invoke('ios-backups'),
  iosScan: (args) => ipcRenderer.invoke('ios-scan', args),
  iosExtract: (args) => ipcRenderer.invoke('ios-extract', args),

  // progress stream
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },
});
