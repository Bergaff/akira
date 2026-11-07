import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('akira', Object.freeze({
  settingsStatus: () => ipcRenderer.invoke('akira:settings-status'),
  saveSettings: (values: unknown) => ipcRenderer.invoke('akira:settings-save', values),
  clearSettings: () => ipcRenderer.invoke('akira:settings-clear'),
  jobs: () => ipcRenderer.invoke('akira:jobs'),
  job: (id: number) => ipcRenderer.invoke('akira:job', id),
  parts: (id: number) => ipcRenderer.invoke('akira:parts', id),
  create: (values: unknown) => ipcRenderer.invoke('akira:create', values),
  control: (id: number, action: string) => ipcRenderer.invoke('akira:control', id, action),
  remove: (id: number) => ipcRenderer.invoke('akira:delete', id),
  saveParts: (id: number) => ipcRenderer.invoke('akira:save-parts', id),
}));
