const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    executeScript: (scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions, stitchOptions, ocrModel) =>
        ipcRenderer.invoke('execute-script', { scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions, stitchOptions, ocrModel }),
    loadConfig: () =>
        ipcRenderer.invoke('load-config'),
    saveConfig: (config) =>
        ipcRenderer.invoke('save-config', config),
    openExternalUrl: (url) =>
        ipcRenderer.invoke('open-external-url', url),
    getSetupStatus: () =>
        ipcRenderer.invoke('get-setup-status'),
    chooseToolsRoot: (options) =>
        ipcRenderer.invoke('choose-tools-root', options),
    prepareNdlocrRoot: () =>
        ipcRenderer.invoke('prepare-ndlocr-root'),
    onLog: (callback) =>
        ipcRenderer.on('script-log', (_event, value) => callback(value)),
    onError: (callback) =>
        ipcRenderer.on('script-error', (_event, value) => callback(value)),
    getPathForFile: (file) =>
        webUtils.getPathForFile(file),
    readClipboardText: () =>
        ipcRenderer.invoke('read-clipboard-text'),
    resizeMainWindow: (mode) =>
        ipcRenderer.invoke('resize-main-window', mode)
});
