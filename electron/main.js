'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store');
const { fixWebmDuration } = require('./webm-duration');

const APP_NAME = 'MeetMinder';
const isMac = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');

// Keep in sync with RECORDING_BITRATE in js/recorder.js (used to estimate the length of interrupted recordings).
const RECORDING_BITRATE = 64000;
const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'wav', 'webm', 'ogg', 'oga', 'opus', 'aac', 'flac',
  'mp4', 'm4b', 'mov', 'aiff', 'aif', 'caf', 'amr', '3gp', 'wma',
];

let mainWindow = null;
let store = null;
let dirs = null;
let recoveredOnLaunch = 0;

/** meetingId -> { stream, filePath } for recordings that are currently being written. */
const activeRecordings = new Map();
let sleepBlockerId = null;

// Closing the window / quitting while a recording is running.
let quitting = false;
let allowClose = false;
let pendingAction = null;
let stopTimer = null;

/* ------------------------------------------------------------------ helpers */

function resolveDirs() {
  // MEETMINDER_HOME lets you keep the library somewhere else (handy for testing or an external drive).
  const root = process.env.MEETMINDER_HOME
    ? path.resolve(process.env.MEETMINDER_HOME)
    : path.join(app.getPath('documents'), APP_NAME);
  return {
    root,
    recordings: path.join(root, 'Recordings'),
    dataFile: path.join(root, 'meetminder-data.json'),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** 2026-10-06_14-30-05 — no colons, so it is a valid file name on macOS and Windows. */
function timestamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** "Priya Sharma" -> "Priya_Sharma"; strips characters that are not allowed in file names. */
function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60);
  return cleaned || 'Customer';
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}_${i}${ext}`);
  return candidate;
}

function extensionForMime(mimeType = '') {
  if (mimeType.includes('mp4')) return '.m4a';
  if (mimeType.includes('ogg')) return '.ogg';
  return '.webm';
}

function displayPath(p) {
  const home = os.homedir();
  return !process.platform.startsWith('win') && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function meetingFile(meeting) {
  return path.join(dirs.recordings, meeting.fileName);
}

/** Adds file information the renderer needs (paths are always resolved here, never trusted from the UI). */
function decorate(meeting) {
  const filePath = meetingFile(meeting);
  return {
    ...meeting,
    filePath,
    fileUrl: pathToFileURL(filePath).href,
    fileExists: fs.existsSync(filePath),
  };
}

function snapshot() {
  return {
    customers: store.data.customers,
    meetings: store.data.meetings.map(decorate),
    followups: store.data.followups,
  };
}

async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

const estimateDuration = (bytes) => Math.round((bytes * 8) / RECORDING_BITRATE);

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    if (stream.closed || stream.destroyed) return resolve();
    stream.once('close', resolve);
    stream.once('error', reject);
    stream.end();
  });
}

async function moveToTrash(meetings) {
  for (const meeting of meetings) {
    if (!meeting?.fileName) continue;
    const file = meetingFile(meeting);
    if (!fs.existsSync(file)) continue;
    try {
      await shell.trashItem(file);
    } catch (err) {
      console.warn(`Could not move ${file} to the trash:`, err);
    }
  }
}

function updateRecordingIndicators() {
  const recording = activeRecordings.size > 0;
  // Stop the Mac from idling to sleep in the middle of a long meeting.
  if (recording && sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!recording && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  if (isMac) app.dock?.setBadge(recording ? 'REC' : '');
}

/** Closes any open recording streams and keeps whatever audio was captured. */
async function finalizeActiveRecordings() {
  for (const [id, rec] of [...activeRecordings]) {
    activeRecordings.delete(id);
    await closeStream(rec.stream).catch(() => {});
    const size = await fileSize(rec.filePath);
    if (store.meeting(id)) {
      store.setMeetingFields(id, { status: 'ready', recovered: true, sizeBytes: size, durationSec: estimateDuration(size) });
    }
  }
  updateRecordingIndicators();
}

/** Recordings left in "recording" state mean the app was closed unexpectedly; keep the audio. */
async function recoverInterruptedRecordings() {
  let count = 0;
  for (const meeting of store.data.meetings.filter((m) => m.status === 'recording')) {
    const file = meetingFile(meeting);
    const size = await fileSize(file);
    if (size < 4096) {
      await fsp.rm(file, { force: true });
      store.deleteMeeting(meeting.id, { keepFollowups: true });
      continue;
    }
    store.setMeetingFields(meeting.id, { status: 'ready', recovered: true, sizeBytes: size, durationSec: estimateDuration(size) });
    count++;
  }
  return count;
}

async function describeFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('No file selected.');
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('The selected file could not be found.');
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new Error('Please choose an audio file (MP3, M4A, WAV, WEBM, OGG, AAC, FLAC, MP4…).');
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    ext,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    url: pathToFileURL(filePath).href,
  };
}

/* ---------------------------------------------------------------------- IPC */

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    // Only our own bundled page may talk to the main process.
    if (!event.senderFrame || !event.senderFrame.url.startsWith('file://')) {
      throw new Error('Blocked request from an untrusted page.');
    }
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    dirs: { root: dirs.root, recordings: dirs.recordings },
    display: { root: displayPath(dirs.root), recordings: displayPath(dirs.recordings) },
    recovered: recoveredOnLaunch,
  }));

  handle('data:load', async () => {
    // A reloaded page has lost its in-memory recorder: keep what was captured.
    if (activeRecordings.size) await finalizeActiveRecordings();
    return snapshot();
  });

  /* customers */
  handle('customers:create', (input) => store.createCustomer(input));
  handle('customers:update', (id, patch) => store.updateCustomer(id, patch));
  handle('customers:remove', async (id) => {
    if (store.data.meetings.some((m) => m.customerId === id && activeRecordings.has(m.id))) {
      throw new Error('Stop the current recording before deleting this customer.');
    }
    const removed = store.deleteCustomer(id);
    await moveToTrash(removed);
    return snapshot();
  });

  /* meetings */
  handle('meetings:update', (id, patch) => decorate(store.updateMeeting(id, patch)));
  handle('meetings:remove', async (id) => {
    if (activeRecordings.has(id)) throw new Error('This meeting is still being recorded.');
    const meeting = store.deleteMeeting(id);
    if (meeting) await moveToTrash([meeting]);
    return snapshot();
  });
  handle('meetings:reveal', (id) => {
    const meeting = store.mustMeeting(id);
    const file = meetingFile(meeting);
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(dirs.recordings);
  });
  handle('meetings:open-external', async (id) => {
    const error = await shell.openPath(meetingFile(store.mustMeeting(id)));
    if (error) throw new Error(error);
  });
  handle('meetings:pick-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a meeting recording',
      buttonLabel: 'Choose',
      properties: ['openFile'],
      filters: [
        { name: 'Audio & video', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return describeFile(result.filePaths[0]);
  });
  handle('meetings:describe-file', (filePath) => describeFile(filePath));
  handle('meetings:import', async (input = {}) => {
    const customer = store.customer(input.customerId);
    if (!customer) throw new Error('Please choose the customer for this meeting.');
    const file = await describeFile(input.sourcePath);
    const date = new Date(input.startedAt);
    const startedAt = Number.isNaN(date.getTime()) ? new Date() : date;
    const target = uniquePath(dirs.recordings, `${safeName(customer.name)}_${timestamp(startedAt)}`, `.${file.ext}`);
    await fsp.mkdir(dirs.recordings, { recursive: true });
    await fsp.copyFile(file.path, target, fs.constants.COPYFILE_EXCL);
    const meeting = store.createMeeting({
      customerId: customer.id,
      title: input.title || `Meeting with ${customer.name}`,
      source: 'uploaded',
      fileName: path.basename(target),
      originalName: file.name,
      startedAt: startedAt.toISOString(),
      durationSec: input.durationSec,
      sizeBytes: file.size,
      notes: input.notes,
      status: 'ready',
    });
    return decorate(meeting);
  });

  /* live recording: the renderer streams audio chunks here as they are captured */
  handle('recording:start', async ({ customerId, title, mimeType } = {}) => {
    const customer = store.customer(customerId);
    if (!customer) throw new Error('Please choose a customer before recording.');
    await fsp.mkdir(dirs.recordings, { recursive: true });
    const startedAt = new Date();
    const filePath = uniquePath(
      dirs.recordings,
      `${safeName(customer.name)}_${timestamp(startedAt)}`,
      extensionForMime(typeof mimeType === 'string' ? mimeType : ''),
    );
    const stream = fs.createWriteStream(filePath, { flags: 'wx' });
    await new Promise((resolve, reject) => {
      stream.once('open', resolve);
      stream.once('error', reject);
    });
    const meeting = store.createMeeting({
      customerId,
      title: title || `Meeting with ${customer.name}`,
      source: 'recorded',
      fileName: path.basename(filePath),
      mimeType,
      startedAt: startedAt.toISOString(),
      status: 'recording',
    });
    activeRecordings.set(meeting.id, { stream, filePath });
    updateRecordingIndicators();
    return decorate(meeting);
  });

  handle('recording:append', async (id, chunk) => {
    const rec = activeRecordings.get(id);
    if (!rec) throw new Error('This recording is no longer active.');
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid audio data.');
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    await new Promise((resolve, reject) => rec.stream.write(buffer, (err) => (err ? reject(err) : resolve())));
    return true;
  });

  handle('recording:finish', async (id, { durationMs } = {}) => {
    const rec = activeRecordings.get(id);
    if (!rec) throw new Error('This recording is no longer active.');
    activeRecordings.delete(id);
    updateRecordingIndicators();
    await closeStream(rec.stream);
    if (rec.filePath.endsWith('.webm')) {
      try {
        await fixWebmDuration(rec.filePath, Number(durationMs));
      } catch (err) {
        console.warn('Could not write the recording duration:', err);
      }
    }
    const meeting = store.setMeetingFields(id, {
      status: 'ready',
      durationSec: Math.max(0, Math.round(Number(durationMs) / 1000) || 0),
      sizeBytes: await fileSize(rec.filePath),
    });
    return decorate(meeting);
  });

  handle('recording:discard', async (id) => {
    const rec = activeRecordings.get(id);
    if (rec) {
      activeRecordings.delete(id);
      updateRecordingIndicators();
      await closeStream(rec.stream).catch(() => {});
    }
    const meeting = store.meeting(id);
    if (meeting) {
      await fsp.rm(meetingFile(meeting), { force: true });
      store.deleteMeeting(id);
    }
    return snapshot();
  });

  /* follow-ups */
  handle('followups:create', (input) => store.createFollowup(input));
  handle('followups:update', (id, patch) => store.updateFollowup(id, patch));
  handle('followups:remove', (id) => {
    store.deleteFollowup(id);
    return true;
  });

  /* system */
  handle('system:open-recordings', async () => {
    await fsp.mkdir(dirs.recordings, { recursive: true });
    return shell.openPath(dirs.recordings);
  });
  handle('system:mic-access', async () => {
    if (!isMac && process.platform !== 'win32') return 'granted';
    let status = systemPreferences.getMediaAccessStatus('microphone');
    if (isMac && status === 'not-determined') {
      status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    }
    return status;
  });
  handle('system:open-mic-settings', () =>
    shell.openExternal(
      isMac
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : 'ms-settings:privacy-microphone',
    ),
  );

  handle('app:stopped-for-close', () => completePendingAction());
}

/* ------------------------------------------------------- closing while recording */

function askToStopRecording(action) {
  if (!mainWindow) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Stop & Save', 'Keep Recording'],
    defaultId: 0,
    cancelId: 1,
    message: 'A meeting is still being recorded.',
    detail: 'Stop the recording and save it before closing MeetMinder?',
  });
  if (choice !== 0) {
    quitting = false;
    return;
  }
  pendingAction = action;
  mainWindow.webContents.send('recording:stop-request');
  // Safety net: if the page does not respond, keep the audio captured so far and continue.
  clearTimeout(stopTimer);
  stopTimer = setTimeout(async () => {
    await finalizeActiveRecordings();
    completePendingAction();
  }, 20000);
}

function completePendingAction() {
  clearTimeout(stopTimer);
  const action = pendingAction;
  pendingAction = null;
  if (!action) return;
  allowClose = true;
  if (action === 'quit') app.quit();
  else mainWindow?.close();
}

/* -------------------------------------------------------------------- window */

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function send(channel, ...args) {
  if (!mainWindow) createWindow();
  focusWindow();
  mainWindow.webContents.send(channel, ...args);
}

function createWindow() {
  allowClose = false;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: APP_NAME,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f15' : '#f4f5fa',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    autoHideMenuBar: !isMac,
    icon: !isMac && fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep recording timers accurate while the window is in the background.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.loadFile(path.join(ROOT, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Dropping a file anywhere must never navigate away from the app.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => finalizeActiveRecordings());

  mainWindow.on('close', (event) => {
    if (allowClose || activeRecordings.size === 0) return;
    event.preventDefault();
    askToStopRecording(quitting || !isMac ? 'quit' : 'close');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const dev = !app.isPackaged;
  const template = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Record Meeting…', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('menu:record') },
        { label: 'Upload Meeting…', accelerator: 'CmdOrCtrl+U', click: () => send('menu:upload') },
        { label: 'Add Customer…', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:add-customer') },
        { type: 'separator' },
        { label: 'Open Recordings Folder', click: () => shell.openPath(dirs.recordings) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('menu:navigate', 'dashboard') },
        { label: 'Meetings', accelerator: 'CmdOrCtrl+2', click: () => send('menu:navigate', 'meetings') },
        { type: 'separator' },
        ...(dev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------------------------------------- lifecycle */

async function init() {
  dirs = resolveDirs();
  fs.mkdirSync(dirs.recordings, { recursive: true });
  store = new Store(dirs.dataFile);
  store.load();
  recoveredOnLaunch = await recoverInterruptedRecordings();

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Record meetings. Mark what matters. Never miss a follow-up.',
  });

  // Allow the microphone (audio only); deny every other web permission.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const audioOnly = !(details?.mediaTypes || []).includes('video');
    callback(permission === 'media' && audioOnly);
  });

  registerIpc();
  buildMenu();
  createWindow();
  if (isMac && !app.isPackaged && fs.existsSync(ICON)) app.dock?.setIcon(ICON);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  app.on('second-instance', focusWindow);

  app
    .whenReady()
    .then(init)
    .catch((err) => {
      console.error(err);
      dialog.showErrorBox(
        'MeetMinder could not start',
        `${err.message}\n\nMeetMinder keeps its recordings in ${dirs ? dirs.root : 'Documents/MeetMinder'}. ` +
          'If macOS asked for access to your Documents folder, allow it in System Settings → Privacy & Security → ' +
          'Files and Folders, then open MeetMinder again.',
      );
      app.exit(1);
    });

  app.on('activate', () => {
    if (!mainWindow && store) createWindow();
    else focusWindow();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (activeRecordings.size > 0 && !allowClose) {
      event.preventDefault();
      askToStopRecording('quit');
    }
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
