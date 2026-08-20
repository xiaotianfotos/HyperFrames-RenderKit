import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hyperframesRenderKit", {
  getConfig: () => ipcRenderer.invoke("renderkit:get-config"),
  writePayload: (payload) => ipcRenderer.invoke("renderkit:write-payload", payload),
  captureFrame: (payload) => ipcRenderer.invoke("renderkit:capture-frame", payload),
  setScreenshotMediaAccess: (payload) => ipcRenderer.invoke("renderkit:set-screenshot-media-access", payload),
  decoderOpenSource: (payload) => ipcRenderer.invoke("renderkit:decoder-open-source", payload),
  decoderResolveTarget: (payload) => ipcRenderer.invoke("renderkit:decoder-resolve-target", payload),
  decoderBeginCursor: (payload) => ipcRenderer.invoke("renderkit:decoder-begin-cursor", payload),
  decoderNextBatch: (payload) => ipcRenderer.invoke("renderkit:decoder-next-batch", payload),
  decoderAckBatch: (payload) => ipcRenderer.invoke("renderkit:decoder-ack-batch", payload),
  decoderReleaseCursor: (payload) => ipcRenderer.invoke("renderkit:decoder-release-cursor", payload),
  decoderCloseSource: (payload) => ipcRenderer.invoke("renderkit:decoder-close-source", payload),
  decoderStats: () => ipcRenderer.invoke("renderkit:decoder-stats"),
  reportSupport: (payload) => ipcRenderer.invoke("renderkit:report-support", payload),
  reportResults: (payload) => ipcRenderer.invoke("renderkit:report-results", payload),
  reportProgress: (payload) => ipcRenderer.send("renderkit:progress", payload),
  finish: (payload) => ipcRenderer.invoke("renderkit:finish", payload),
  fail: (message) => ipcRenderer.invoke("renderkit:fail", String(message)),
});
