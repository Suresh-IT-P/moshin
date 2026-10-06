'use strict';

/**
 * The bridge between the UI (index.html + js/) and Node.js (electron/main.js).
 * The page gets a small, explicit `window.api` instead of full Node access.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    // "Error invoking remote method 'x': Error: Something" -> "Something"
    const message = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    throw new Error(message);
  });
}

const EVENTS = new Set(['recording:stop-request', 'menu:navigate', 'menu:record', 'menu:upload', 'menu:add-customer']);

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => call('app:info'),
    stoppedForClose: () => call('app:stopped-for-close'),
  },
  data: {
    load: () => call('data:load'),
  },
  customers: {
    create: (input) => call('customers:create', input),
    update: (id, patch) => call('customers:update', id, patch),
    remove: (id) => call('customers:remove', id),
  },
  meetings: {
    update: (id, patch) => call('meetings:update', id, patch),
    remove: (id) => call('meetings:remove', id),
    reveal: (id) => call('meetings:reveal', id),
    openExternal: (id) => call('meetings:open-external', id),
    pickFile: () => call('meetings:pick-file'),
    describeFile: (filePath) => call('meetings:describe-file', filePath),
    importFile: (input) => call('meetings:import', input),
  },
  recording: {
    start: (options) => call('recording:start', options),
    append: (id, chunk) => call('recording:append', id, chunk),
    finish: (id, options) => call('recording:finish', id, options),
    discard: (id) => call('recording:discard', id),
  },
  followups: {
    create: (input) => call('followups:create', input),
    update: (id, patch) => call('followups:update', id, patch),
    remove: (id) => call('followups:remove', id),
  },
  system: {
    openRecordings: () => call('system:open-recordings'),
    micAccess: () => call('system:mic-access'),
    openMicSettings: () => call('system:open-mic-settings'),
    /** Absolute path of a file dropped onto the window. */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  on(channel, callback) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
