const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    executeScript: (scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions, stitchOptions) =>
        ipcRenderer.invoke('execute-script', { scriptKey, filePaths, aiProvider, processMode, ocrMode, preferPdfText, autoRename, skipFormattedRename, batchSize, ocrTarget, audioOptions, silenceTrim, contextText, splitJson, pdfPageOptions, stitchOptions }),
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
        clipboard.readText(),
    resizeMainWindow: (mode) =>
        ipcRenderer.invoke('resize-main-window', mode)
});
