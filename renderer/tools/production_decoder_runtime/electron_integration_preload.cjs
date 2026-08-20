const { contextBridge, ipcRenderer } = require("electron");

const channel = (name) => `hf:production-decoder:${name}`;
const invoke = (name) => (request) => ipcRenderer.invoke(channel(name), request);

contextBridge.exposeInMainWorld("hyperframesDecoder", Object.freeze({
  decoderOpenSource: invoke("open-source"),
  decoderResolveTarget: invoke("resolve-target"),
  decoderBeginCursor: invoke("begin-cursor"),
  decoderNextBatch: invoke("next-batch"),
  decoderAckBatch: invoke("ack-batch"),
  decoderReleaseCursor: invoke("release-cursor"),
  decoderCloseSource: invoke("close-source"),
  decoderStats: () => ipcRenderer.invoke(channel("stats")),
}));

contextBridge.exposeInMainWorld("productionDecoderIntegration", Object.freeze({
  config: () => ipcRenderer.invoke(channel("integration-config")),
  reportResult: (result) => ipcRenderer.send(channel("integration-result"), result),
  reportError: (error) => ipcRenderer.send(channel("integration-error"), error),
}));
