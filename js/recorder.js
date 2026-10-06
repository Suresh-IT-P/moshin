/* Live meeting recording: setup dialog, recording session, recorder screen and mini pill. */

import { el, esc, avatar, fmtClock, debounce, safeFileName, fileStamp, modKey, isMac, isTyping } from './utils.js';
import { icon } from './icons.js';
import {
  state,
  subscribe,
  getCustomer,
  putMeeting,
  replaceAll,
  reload,
  followupsForMeeting,
  createFollowup,
  updateMeeting,
} from './store.js';
import { openModal, topLayer, toast, toastError, confirmDialog, dueField, withBusy } from './ui.js';
import { pickCustomer } from './customers.js';
import { followupItem } from './followups.js';

const api = window.api;

// Opus at 64 kbps ≈ 29 MB per hour and sounds great for voices. Keep in sync with electron/main.js.
export const RECORDING_BITRATE = 64000;
const CHUNK_MS = 1000; // audio is flushed to disk every second
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

let session = null;
let view = null;
let openMeeting = () => {};
const sessionListeners = new Set();

export const getSession = () => session;
export const isRecording = () => Boolean(session);

export function configureRecorder({ onOpenMeeting }) {
  openMeeting = onOpenMeeting;
}

export function onSessionChange(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

function sessionChanged() {
  updateChrome();
  for (const fn of [...sessionListeners]) fn(session);
}

/* ------------------------------------------------------------- microphone */

async function micAllowed() {
  const status = await api.system.micAccess().catch(() => 'unknown');
  return status !== 'denied' && status !== 'restricted';
}

function getMicStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Off, so voices coming out of the speakers (online meetings) are recorded too.
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

class LevelMeter {
  constructor(stream) {
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.ctx.resume().catch(() => {});
  }

  /** 0..1, roughly -60 dB … 0 dB */
  level() {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const db = 20 * Math.log10(Math.sqrt(sum / this.buffer.length) + 1e-8);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  close() {
    try {
      this.source.disconnect();
    } catch {}
    this.ctx.close().catch(() => {});
  }
}

/* -------------------------------------------------------- recording session */

class RecordingSession {
  constructor({ customerId, title, stream }) {
    this.customerId = customerId;
    this.title = title;
    this.stream = stream;
    this.meeting = null;
    this.recorder = null;
    this.meter = null;
    this.state = 'idle'; // recording | paused | stopping | stopped | discarded
    this.marks = [];
    this.notes = '';
    this.levels = [];
    this.writes = Promise.resolve();
    this.writeError = null;
    this.startTime = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.listeners = new Set();
    this.saveMeta = debounce(() => this.persistMeta(), 700);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail) {
    for (const fn of [...this.listeners]) fn(type, detail);
  }

  get customer() {
    return getCustomer(this.customerId);
  }

  get active() {
    return this.state === 'recording' || this.state === 'paused';
  }

  /** Time actually recorded (pauses excluded) — this is the position in the audio file. */
  get elapsedMs() {
    if (!this.startTime) return 0;
    const end = this.pausedAt || performance.now();
    return Math.max(0, end - this.startTime - this.pausedTotal);
  }

  get elapsed() {
    return this.elapsedMs / 1000;
  }

  async start() {
    const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    this.meeting = await api.recording.start({ customerId: this.customerId, title: this.title, mimeType });
    putMeeting(this.meeting);
    try {
      this.recorder = new MediaRecorder(this.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: RECORDING_BITRATE,
      });
    } catch (err) {
      replaceAll(await api.recording.discard(this.meeting.id));
      throw err;
    }
    this.recorder.addEventListener('dataavailable', (e) => this.write(e.data));
    this.recorder.addEventListener('error', (e) =>
      this.emit('problem', e.error?.message || 'The recorder stopped unexpectedly.'),
    );
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.active) this.emit('problem', 'The microphone was disconnected, so the recording was stopped and saved.');
      });
    }
    this.meter = new LevelMeter(this.stream);
    this.recorder.start(CHUNK_MS);
    this.startTime = performance.now();
    this.state = 'recording';
    this.sampler = setInterval(() => this.sample(), 90);
    this.ticker = setInterval(() => this.emit('tick'), 250);
    this.emit('state');
  }

  sample() {
    this.levels.push(this.state === 'recording' && this.meter ? this.meter.level() : 0);
    if (this.levels.length > 800) this.levels.splice(0, this.levels.length - 800);
  }

  /** Chunks are appended to the file in order, as they arrive. */
  write(blob) {
    if (!blob || !blob.size) return;
    this.writes = this.writes
      .then(async () => {
        if (this.writeError) return;
        await api.recording.append(this.meeting.id, new Uint8Array(await blob.arrayBuffer()));
      })
      .catch((err) => {
        if (this.writeError) return;
        this.writeError = err;
        this.emit('problem', `Could not save audio to disk: ${err.message}`);
      });
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = performance.now();
    this.state = 'paused';
    this.emit('state');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    this.state = 'recording';
    this.emit('state');
  }

  addMark(note = '') {
    if (!this.active) return null;
    const mark = {
      id: crypto.randomUUID(),
      t: Math.round(this.elapsed * 10) / 10,
      note,
      createdAt: new Date().toISOString(),
    };
    this.marks.push(mark);
    this.saveMeta();
    this.emit('marks', mark);
    return mark;
  }

  updateMark(id, note) {
    const mark = this.marks.find((m) => m.id === id);
    if (!mark) return;
    mark.note = note;
    this.saveMeta();
  }

  removeMark(id) {
    this.marks = this.marks.filter((m) => m.id !== id);
    this.saveMeta();
    this.emit('marks');
  }

  setNotes(text) {
    this.notes = text;
    this.saveMeta();
  }

  /** Notes and moments are saved while recording, so they survive a crash too. */
  async persistMeta() {
    if (!this.meeting) return;
    try {
      await updateMeeting(this.meeting.id, { marks: this.marks, notes: this.notes });
    } catch (err) {
      console.warn('Could not save notes while recording:', err);
    }
  }

  stopRecorder() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') return resolve();
      this.recorder.addEventListener('stop', () => resolve(), { once: true });
      try {
        this.recorder.stop();
      } catch {
        resolve();
      }
    });
  }

  releaseMedia() {
    clearInterval(this.sampler);
    clearInterval(this.ticker);
    this.meter?.close();
    this.meter = null;
    for (const track of this.stream.getTracks()) track.stop();
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const durationMs = this.elapsedMs;
      this.state = 'stopping';
      this.emit('state');
      await this.stopRecorder(); // flushes the last chunk
      await this.writes;
      this.releaseMedia();
      this.saveMeta.cancel();
      await this.persistMeta();
      const meeting = await api.recording.finish(this.meeting.id, { durationMs });
      putMeeting(meeting);
      this.state = 'stopped';
      this.emit('state');
      return meeting;
    })();
    return this.stopping;
  }

  async discard() {
    this.state = 'discarded';
    this.saveMeta.cancel();
    await this.stopRecorder();
    await this.writes;
    this.releaseMedia();
    replaceAll(await api.recording.discard(this.meeting.id));
    this.emit('state');
  }
}

/* -------------------------------------------------------------- setup dialog */

/** Entry point for every "Record" button. */
export function startRecordingFlow({ customerId = null } = {}) {
  if (session) {
    openRecorder();
    return;
  }
  openSetup({ customerId });
}

function openSetup({ customerId }) {
  let stream = null;
  let meter = null;
  let raf = 0;
  let heardSomething = false;
  let silenceTimer = 0;

  const body = el(`
    <div class="record-setup">
      <div class="callout callout-danger" data-mic-blocked hidden>
        ${icon('alert', 18)}
        <div>
          <strong>Microphone access is turned off</strong>
          <p>Allow MeetMinder in ${isMac() ? 'System Settings → Privacy &amp; Security → Microphone' : 'Settings → Privacy → Microphone'}, then open this window again.</p>
        </div>
        <button type="button" class="btn btn-soft btn-sm" data-open-settings>Open Settings</button>
      </div>
      <div class="field">
        <label>Who is this meeting with? <span class="req">*</span></label>
        <div data-slot="customer"></div>
        <p class="hint">New customer? Type their name and pick <b>Add as a new customer</b>.</p>
      </div>
      <div class="field">
        <label for="rs-title">Meeting title <span class="optional">optional</span></label>
        <input id="rs-title" class="input" name="title" maxlength="200" placeholder="e.g. Pricing discussion" />
      </div>
      <div class="field">
        <label for="rs-mic">Microphone</label>
        <div class="mic-row">
          <div class="select-wrap">
            <select id="rs-mic" class="input"><option value="">Default microphone</option></select>
            ${icon('chevron-down', 16)}
          </div>
          <div class="level" data-level aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i style="height:${8 + i}px"></i>`).join('')}</div>
        </div>
        <p class="hint" data-mic-hint>Say something — the bars should move.</p>
      </div>
      <div class="save-hint">
        ${icon('folder', 16)}
        <span>Saved as <code data-filename></code> in <code>${esc(state.info.display.recordings)}</code></span>
      </div>
    </div>`);

  const modal = openModal({
    title: 'Record a meeting',
    subtitle: 'Choose the customer, check your microphone, and start.',
    body,
    footer: `
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
      <button type="button" class="btn btn-rec" data-start disabled>${icon('record-fill', 16)} Start recording</button>`,
  });

  const startButton = modal.footer.querySelector('[data-start]');
  const select = body.querySelector('#rs-mic');
  const hint = body.querySelector('[data-mic-hint]');
  const bars = [...body.querySelectorAll('[data-level] i')];
  const fileNameEl = body.querySelector('[data-filename]');

  const picker = pickCustomer({ value: customerId, onChange: refresh });
  body.querySelector('[data-slot="customer"]').append(picker.el);

  function refresh() {
    const customer = getCustomer(picker.value);
    fileNameEl.textContent = `${safeFileName(customer?.name || 'CustomerName')}_${fileStamp()}.webm`;
    body.querySelector('#rs-title').placeholder = customer ? `Meeting with ${customer.name}` : 'e.g. Pricing discussion';
    startButton.disabled = !picker.value || !stream;
  }

  function stopPreview() {
    cancelAnimationFrame(raf);
    clearTimeout(silenceTimer);
    meter?.close();
    meter = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function animate() {
    const level = meter ? meter.level() : 0;
    const lit = Math.round(level * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle('on', i < lit));
    if (level > 0.25 && !heardSomething) {
      heardSomething = true;
      hint.textContent = 'Sounds good — your microphone is working.';
      hint.classList.remove('is-warning');
      hint.classList.add('is-ok');
    }
    raf = requestAnimationFrame(animate);
  }

  async function useMic(deviceId) {
    stopPreview();
    heardSomething = false;
    hint.className = 'hint';
    hint.textContent = 'Say something — the bars should move.';
    let next;
    try {
      next = await getMicStream(deviceId);
    } catch (err) {
      hint.textContent = `Couldn’t open the microphone (${err.message || err.name}).`;
      hint.classList.add('is-warning');
      refresh();
      return;
    }
    if (modal.closed) {
      next.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = next;
    meter = new LevelMeter(stream);
    animate();
    silenceTimer = setTimeout(() => {
      if (!heardSomething && stream) {
        hint.textContent = 'We can’t hear much yet — check the microphone, or just start if the room is quiet.';
        hint.classList.add('is-warning');
      }
    }, 5000);
    refresh();
  }

  async function fillDevices() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const current = stream?.getAudioTracks()[0]?.getSettings().deviceId || '';
    select.innerHTML = devices.length
      ? devices
          .map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === current ? 'selected' : ''}>${esc(d.label || `Microphone ${i + 1}`)}</option>`)
          .join('')
      : '<option value="">Default microphone</option>';
  }

  (async () => {
    if (!(await micAllowed())) {
      body.querySelector('[data-mic-blocked]').hidden = false;
      hint.textContent = 'Microphone access is needed to record.';
      hint.classList.add('is-warning');
      return;
    }
    await useMic();
    if (!modal.closed) await fillDevices().catch(() => {});
  })();

  select.addEventListener('change', () => useMic(select.value));
  body.querySelector('[data-open-settings]').addEventListener('click', () => api.system.openMicSettings());

  startButton.addEventListener('click', () =>
    withBusy(startButton, 'Starting…', async () => {
      const handOff = stream;
      const next = new RecordingSession({
        customerId: picker.value,
        title: body.querySelector('#rs-title').value.trim(),
        stream: handOff,
      });
      // The preview stream becomes the recording stream.
      cancelAnimationFrame(raf);
      clearTimeout(silenceTimer);
      meter?.close();
      meter = null;
      stream = null;
      try {
        await next.start();
      } catch (err) {
        handOff.getTracks().forEach((t) => t.stop());
        throw err;
      }
      attachSession(next);
      modal.close();
      openRecorder();
    }).catch((err) => {
      toastError(err);
      if (!modal.closed && !stream) useMic(select.value);
    }),
  );

  modal.onCleanup(() => {
    picker.destroy();
    stopPreview();
  });
  refresh();
}

/* ------------------------------------------------------- session lifecycle */

function attachSession(next) {
  session = next;
  next.on((type, detail) => {
    if (type === 'tick' || type === 'state') updateTimers();
    if (type === 'state') updateChrome();
    if (type === 'problem') handleProblem(next, detail);
  });
  sessionChanged();
}

function endSession(ended) {
  if (session !== ended) return;
  session = null;
  view?.destroy();
  view = null;
  sessionChanged();
}

async function handleProblem(s, message) {
  if (s !== session || s.stopping) return;
  toast(message, { type: 'error' });
  await stopRecording();
}

/** Stops and saves the active recording. */
export async function stopRecording({ openAfter = true } = {}) {
  const s = session;
  if (!s) return null;
  try {
    const meeting = await s.stop();
    endSession(s);
    toast(`Meeting saved as ${meeting.fileName}`);
    if (openAfter) openMeeting(meeting.id);
    return meeting;
  } catch (err) {
    endSession(s);
    toastError(err);
    await reload().catch(() => {});
    return null;
  }
}

async function discardRecording() {
  const s = session;
  if (!s) return;
  const ok = await confirmDialog({
    title: 'Discard this recording?',
    message: 'The audio, key moments, notes and follow-ups captured so far will be deleted. This can’t be undone.',
    confirmLabel: 'Discard recording',
    danger: true,
  });
  if (!ok || session !== s) return;
  try {
    await s.discard();
    toast('Recording discarded', { type: 'info' });
  } catch (err) {
    toastError(err);
    await reload().catch(() => {});
  }
  endSession(s);
}

/* --------------------------------------------- recorder screen & mini pill */

function updateTimers() {
  const text = fmtClock(session ? session.elapsed : 0);
  for (const node of document.querySelectorAll('[data-rec-timer]')) node.textContent = text;
}

const pill = el(`
  <div class="rec-pill" hidden>
    <button type="button" class="rec-pill-main" data-act="open" title="Open the recorder">
      <span class="rec-dot"></span>
      <span class="rec-pill-time" data-rec-timer>00:00</span>
      <span class="rec-pill-name"></span>
    </button>
    <button type="button" class="rec-pill-btn" data-act="mark" title="Mark this moment">${icon('flag', 15)}</button>
    <button type="button" class="rec-pill-btn" data-act="open" title="Open the recorder">${icon('maximize', 15)}</button>
  </div>`);

pill.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'mark') {
    const mark = session?.addMark();
    if (mark) toast(`Moment marked at ${fmtClock(mark.t)}`, { type: 'info', duration: 1800 });
  } else if (act === 'open') openRecorder();
});

function updateChrome() {
  const active = Boolean(session);
  const paused = session?.state === 'paused';
  document.body.classList.toggle('is-recording', active);
  if (!pill.isConnected) document.body.append(pill);
  pill.hidden = !active || Boolean(view?.visible);
  pill.classList.toggle('is-paused', paused);
  pill.querySelector('.rec-pill-name').textContent = session?.customer?.name || '';
  const sidebar = document.getElementById('sidebar-rec');
  if (sidebar) {
    sidebar.hidden = !active;
    sidebar.classList.toggle('is-paused', paused);
    sidebar.querySelector('strong').textContent = paused ? 'Paused' : 'Recording';
  }
  updateTimers();
}

export function openRecorder() {
  if (!session) return;
  if (!view) view = createRecorderView(session);
  view.show();
  updateChrome();
}

function createRecorderView(s) {
  const customer = s.customer;
  const node = el(`
    <div class="recorder-layer">
      <div class="recorder" role="dialog" aria-label="Recorder">
        <header class="recorder-head">
          <div class="rec-badge"><span class="rec-dot"></span><span data-rec-label>Recording</span></div>
          <div class="recorder-who">
            ${avatar(customer, 'md')}
            <div>
              <strong>${esc(s.meeting.title)}</strong>
              <span>${esc(customer?.name || '')}${customer?.company ? ` · ${esc(customer.company)}` : ''}</span>
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-act="minimize" title="Hide the recorder — recording continues">
            ${icon('minimize', 15)} Minimize
          </button>
        </header>

        <div class="recorder-body">
          <section class="recorder-stage">
            <div class="rec-timer" data-rec-timer>00:00</div>
            <p class="rec-file">${icon('file-audio', 14)} ${esc(s.meeting.fileName)}</p>
            <div class="rec-wave-wrap">
              <canvas class="rec-wave"></canvas>
              <div class="mark-flash" data-flash></div>
            </div>
            <div class="rec-controls">
              <button type="button" class="round-btn" data-act="pause">
                <span class="round-btn-icon" data-pause-icon>${icon('pause-fill', 22)}</span>
                <span data-pause-label>Pause</span>
              </button>
              <button type="button" class="round-btn round-btn-stop" data-act="stop">
                <span class="round-btn-icon">${icon('stop-fill', 30)}</span>
                <span>Stop &amp; save</span>
              </button>
              <button type="button" class="round-btn round-btn-mark" data-act="mark">
                <span class="round-btn-icon">${icon('flag', 22)}</span>
                <span>Mark moment</span>
              </button>
            </div>
            <p class="rec-tip">
              ${icon('sparkles', 14)}
              <span>Press <kbd>${modKey()}</kbd>&nbsp;<kbd>B</kbd> to mark a moment without leaving your notes — later, jump straight to it instead of replaying the whole meeting.</span>
            </p>
            <button type="button" class="link-btn link-danger" data-act="discard">Discard recording</button>
          </section>

          <aside class="recorder-side">
            <div class="tabs tabs-fill" role="tablist">
              <button type="button" class="tab is-active" data-tab="moments">${icon('flag', 14)} Moments <span class="tab-count" data-count-moments>0</span></button>
              <button type="button" class="tab" data-tab="notes">${icon('notes', 14)} Notes</button>
              <button type="button" class="tab" data-tab="followups">${icon('list-checks', 14)} Follow-ups <span class="tab-count" data-count-followups>0</span></button>
            </div>
            <div class="side-panel" data-panel="moments"></div>
            <div class="side-panel" data-panel="notes" hidden>
              <textarea class="input notes-area" placeholder="Type key points as they come up — prices, decisions, names, dates…"></textarea>
              <p class="hint">${icon('check-circle', 13)} Saved automatically</p>
            </div>
            <div class="side-panel" data-panel="followups" hidden>
              <form class="quick-fu" novalidate>
                <input class="input" name="title" maxlength="300" placeholder="e.g. Send the proposal" />
                <div data-slot="due"></div>
                <button type="submit" class="btn btn-primary btn-sm btn-block">${icon('plus', 15)} Add follow-up</button>
              </form>
              <div class="fu-list fu-list-compact" data-followups></div>
            </div>
          </aside>
        </div>
      </div>
    </div>`);

  const canvas = node.querySelector('canvas');
  const momentsPanel = node.querySelector('[data-panel="moments"]');
  const followupsEl = node.querySelector('[data-followups]');
  const notesArea = node.querySelector('.notes-area');
  const flashEl = node.querySelector('[data-flash]');
  const fuForm = node.querySelector('.quick-fu');
  const due = dueField({ compact: true });
  fuForm.querySelector('[data-slot="due"]').append(due.el);
  notesArea.value = s.notes;

  let raf = 0;
  let visible = false;
  let flashTimer = 0;

  function switchTab(name) {
    for (const tab of node.querySelectorAll('[data-tab]')) tab.classList.toggle('is-active', tab.dataset.tab === name);
    for (const panel of node.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  }

  function renderMoments() {
    node.querySelector('[data-count-moments]').textContent = s.marks.length;
    const focusedId = document.activeElement?.closest?.('.moment')?.dataset.id;
    const selection = focusedId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    if (!s.marks.length) {
      momentsPanel.innerHTML = `
        <div class="side-empty">
          <span class="side-empty-icon">${icon('flag', 22)}</span>
          <strong>No moments marked yet</strong>
          <p>Tap <b>Mark moment</b> whenever something important is said — a price, a promise, a decision.</p>
        </div>`;
      return;
    }
    momentsPanel.innerHTML = `
      <ol class="moment-list">
        ${s.marks
          .map(
            (m) => `
          <li class="moment" data-id="${m.id}">
            <span class="moment-time">${fmtClock(m.t)}</span>
            <input class="moment-note" value="${esc(m.note)}" maxlength="500" placeholder="What was this about? (optional)" />
            <button type="button" class="icon-btn sm" data-remove title="Remove">${icon('x', 14)}</button>
          </li>`,
          )
          .join('')}
      </ol>`;
    if (focusedId) {
      const input = momentsPanel.querySelector(`.moment[data-id="${focusedId}"] .moment-note`);
      input?.focus();
      if (input && selection) input.setSelectionRange(selection[0], selection[1]);
    }
  }

  function renderFollowups() {
    const list = followupsForMeeting(s.meeting.id);
    node.querySelector('[data-count-followups]').textContent = list.length;
    followupsEl.innerHTML = list.length
      ? list.map((f) => followupItem(f, { showCustomer: false, showMeeting: false })).join('')
      : `<p class="side-note">Promised something? Add it here with a due date — it shows up on your dashboard.</p>`;
  }

  function renderState() {
    const paused = s.state === 'paused';
    const stopping = s.state === 'stopping';
    node.querySelector('.recorder').classList.toggle('is-paused', paused);
    node.querySelector('[data-rec-label]').textContent = stopping ? 'Saving…' : paused ? 'Paused' : 'Recording';
    node.querySelector('[data-pause-icon]').innerHTML = icon(paused ? 'record-fill' : 'pause-fill', 22);
    node.querySelector('[data-act="pause"]').classList.toggle('is-resume', paused);
    node.querySelector('[data-pause-label]').textContent = paused ? 'Resume' : 'Pause';
    for (const button of node.querySelectorAll('.rec-controls button, [data-act="discard"]')) button.disabled = stopping;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w && h) {
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const styles = getComputedStyle(document.body);
      const bar = 3;
      const step = 6;
      const count = Math.floor(w / step);
      const levels = s.levels.slice(-count);
      const offset = count - levels.length;
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, styles.getPropertyValue('--wave-a').trim() || '#6366f1');
      gradient.addColorStop(1, styles.getPropertyValue('--wave-b').trim() || '#ec4899');
      ctx.fillStyle = s.state === 'paused' ? styles.getPropertyValue('--wave-idle').trim() || '#c7cad6' : gradient;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const level = i >= offset ? levels[i - offset] : 0;
        const barHeight = Math.max(4, level * (h - 10));
        ctx.roundRect(i * step, (h - barHeight) / 2, bar, barHeight, 1.5);
      }
      ctx.fill();
      // Fade the oldest bars out on the left.
      ctx.globalCompositeOperation = 'destination-in';
      const fade = ctx.createLinearGradient(0, 0, w * 0.3, 0);
      fade.addColorStop(0, 'rgba(0,0,0,0.05)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
    raf = requestAnimationFrame(draw);
  }

  function flash(mark) {
    flashEl.innerHTML = `${icon('flag', 14)} Moment marked at ${fmtClock(mark.t)}`;
    flashEl.classList.remove('is-on');
    void flashEl.offsetWidth; // restart the animation
    flashEl.classList.add('is-on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove('is-on'), 1600);
  }

  node.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) return switchTab(tab.dataset.tab);
    const remove = e.target.closest('[data-remove]');
    if (remove) return s.removeMark(remove.closest('.moment').dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'minimize') hide();
    else if (act === 'pause') (s.state === 'paused' ? s.resume() : s.pause());
    else if (act === 'discard') discardRecording();
    else if (act === 'mark') {
      const mark = s.addMark();
      if (!mark) return;
      switchTab('moments');
      const input = momentsPanel.querySelector(`.moment[data-id="${mark.id}"] .moment-note`);
      input?.scrollIntoView({ block: 'nearest' });
      input?.focus();
    } else if (act === 'stop') {
      const button = e.target.closest('[data-act]');
      button.classList.add('is-busy');
      await stopRecording();
    }
  });

  momentsPanel.addEventListener('input', (e) => {
    if (e.target.classList.contains('moment-note')) s.updateMark(e.target.closest('.moment').dataset.id, e.target.value);
  });
  momentsPanel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('moment-note')) e.target.blur();
  });
  notesArea.addEventListener('input', () => s.setNotes(notesArea.value));

  fuForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleInput = fuForm.querySelector('[name="title"]');
    const title = titleInput.value.trim();
    if (!title) return titleInput.focus();
    try {
      await createFollowup({ title, dueDate: due.value, meetingId: s.meeting.id });
      titleInput.value = '';
      titleInput.focus();
    } catch (err) {
      toastError(err);
    }
  });

  const offSession = s.on((type, detail) => {
    if (type === 'state') renderState();
    if (type === 'marks') {
      renderMoments();
      if (detail && visible) flash(detail);
    }
  });
  const offStore = subscribe(renderFollowups);

  renderMoments();
  renderFollowups();
  renderState();
  document.body.append(node);

  function show() {
    if (visible) return;
    visible = true;
    document.body.classList.add('recorder-open');
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add('is-open'));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
    updateChrome();
  }

  function hide() {
    if (!visible) return;
    visible = false;
    document.body.classList.remove('recorder-open');
    node.classList.remove('is-open');
    cancelAnimationFrame(raf);
    setTimeout(() => {
      if (!visible) node.hidden = true;
    }, 220);
    updateChrome();
  }

  return {
    show,
    hide,
    get visible() {
      return visible;
    },
    flash,
    destroy() {
      visible = false;
      document.body.classList.remove('recorder-open');
      cancelAnimationFrame(raf);
      clearTimeout(flashTimer);
      offSession();
      offStore();
      node.classList.remove('is-open');
      setTimeout(() => node.remove(), 220);
    },
  };
}

/* ------------------------------------------------------- keyboard shortcuts */

document.addEventListener('keydown', (e) => {
  if (!session?.active) return;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const mark = session.addMark();
    if (mark && !view?.visible) toast(`Moment marked at ${fmtClock(mark.t)}`, { type: 'info', duration: 1800 });
  } else if (e.key === 'Escape' && view?.visible && !topLayer() && !e.defaultPrevented && !isTyping(e.target)) {
    view.hide();
  }
});
