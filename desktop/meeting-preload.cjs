const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('meeting',{call:(action,data)=>ipcRenderer.invoke('meeting',action,data)});
