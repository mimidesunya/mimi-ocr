const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    executeScript: (scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, batchSize, contextFile, splitJson, pdfPageOptions) =>
        ipcRenderer.invoke('execute-script', { scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, batchSize, contextFile, splitJson, pdfPageOptions }),
    openFileDialog: () =>
        ipcRenderer.invoke('open-file-dialog'),
    onLog: (callback) =>
        ipcRenderer.on('script-log', (_event, value) => callback(value)),
    onError: (callback) =>
        ipcRenderer.on('script-error', (_event, value) => callback(value)),
    getPathForFile: (file) =>
        webUtils.getPathForFile(file)
});
