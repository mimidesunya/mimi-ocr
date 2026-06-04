const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    executeScript: (scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions) =>
        ipcRenderer.invoke('execute-script', { scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions }),
    loadConfig: () =>
        ipcRenderer.invoke('load-config'),
    saveConfig: (config) =>
        ipcRenderer.invoke('save-config', config),
    openExternalUrl: (url) =>
        ipcRenderer.invoke('open-external-url', url),
    onLog: (callback) =>
        ipcRenderer.on('script-log', (_event, value) => callback(value)),
    onError: (callback) =>
        ipcRenderer.on('script-error', (_event, value) => callback(value)),
    getPathForFile: (file) =>
        webUtils.getPathForFile(file)
});
