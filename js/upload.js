/* "Upload meeting": import a recording you already have (phone, Zoom, another recorder…). */

import { el, esc, fmtBytes, fmtDuration, toLocalInputValue, safeFileName, fileStamp } from './utils.js';
import { icon } from './icons.js';
import { state, getCustomer, importMeeting } from './store.js';
import { openModal, toast, toastError, withBusy } from './ui.js';
import { pickCustomer } from './customers.js';

const api = window.api;

/** Reads the duration of an audio file (seconds) or resolves null if it can't be decoded. */
function probeDuration(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(Number.isFinite(audio.duration) ? audio.duration : null), 10000);
    audio.addEventListener('error', () => done(null));
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) return done(audio.duration);
      // Some WebM files don't store their length; seeking to the end makes the browser compute it.
      audio.addEventListener('durationchange', () => {
        if (Number.isFinite(audio.duration)) done(audio.duration);
      });
      audio.currentTime = 1e101;
    });
    audio.src = url;
  });
}

export function openUploadModal({ customerId = null, onSaved } = {}) {
  let file = null;
  let durationSec = null;

  const body = el(`
    <div class="upload">
      <div class="dropzone" data-drop tabindex="0" role="button" autofocus aria-label="Choose an audio file">
        <span class="dropzone-icon">${icon('cloud-upload', 28)}</span>
        <strong>Drop a meeting recording here</strong>
        <span>or <u>browse your files</u></span>
        <small>MP3 · M4A · WAV · WEBM · OGG · AAC · FLAC · MP4</small>
      </div>
      <div class="file-card" data-file hidden></div>
      <div class="form-grid">
        <div class="field span-2">
          <label>Customer <span class="req">*</span></label>
          <div data-slot="customer"></div>
        </div>
        <div class="field span-2">
          <label for="up-title">Meeting title <span class="optional">optional</span></label>
          <input id="up-title" class="input" name="title" maxlength="200" placeholder="e.g. Site visit with the purchase team" />
        </div>
        <div class="field span-2">
          <label for="up-when">When did the meeting happen?</label>
          <input id="up-when" class="input" type="datetime-local" name="when" value="${toLocalInputValue(new Date())}" />
        </div>
        <div class="field span-2">
          <label for="up-notes">Notes <span class="optional">optional</span></label>
          <textarea id="up-notes" class="input" name="notes" rows="3" placeholder="Anything you remember from this meeting"></textarea>
        </div>
      </div>
      <div class="save-hint">
        ${icon('folder', 16)}
        <span>A copy is saved as <code data-filename></code> in <code>${esc(state.info.display.recordings)}</code></span>
      </div>
      <p class="form-error" hidden></p>
    </div>`);

  const modal = openModal({
    title: 'Upload a meeting',
    subtitle: 'Add a recording you missed or made on another device.',
    body,
    footer: `
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
      <button type="button" class="btn btn-primary" data-save disabled>${icon('check', 16)} Save meeting</button>`,
  });

  const dropzone = body.querySelector('[data-drop]');
  const fileCard = body.querySelector('[data-file]');
  const whenInput = body.querySelector('[name="when"]');
  const fileNameEl = body.querySelector('[data-filename]');
  const errorEl = body.querySelector('.form-error');
  const saveButton = modal.footer.querySelector('[data-save]');

  const picker = pickCustomer({ value: customerId, onChange: refresh });
  body.querySelector('[data-slot="customer"]').append(picker.el);
  modal.onCleanup(picker.destroy);

  function refresh() {
    const customer = getCustomer(picker.value);
    const when = new Date(whenInput.value);
    const ext = file ? `.${file.ext}` : '.mp3';
    fileNameEl.textContent = `${safeFileName(customer?.name || 'CustomerName')}_${fileStamp(Number.isNaN(when.getTime()) ? new Date() : when)}${ext}`;
    body.querySelector('[name="title"]').placeholder = customer
      ? `Meeting with ${customer.name}`
      : 'e.g. Site visit with the purchase team';
    saveButton.disabled = !file || !picker.value;
  }

  function renderFile() {
    dropzone.hidden = Boolean(file);
    fileCard.hidden = !file;
    if (!file) return;
    fileCard.innerHTML = `
      <span class="file-card-icon">${icon('file-audio', 22)}</span>
      <div class="file-card-text">
        <strong>${esc(file.name)}</strong>
        <span>${esc(fmtBytes(file.size))} · ${durationSec === undefined ? '<span class="spinner spinner-sm"></span> Reading length…' : durationSec ? esc(fmtDuration(durationSec)) : 'Length unknown'}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-change>Change</button>`;
  }

  async function useFile(described) {
    if (!described) return;
    errorEl.hidden = true;
    file = described;
    durationSec = undefined;
    // A file's modified time is usually close to when it was recorded.
    whenInput.value = toLocalInputValue(new Date(file.modifiedAt));
    renderFile();
    refresh();
    const seconds = await probeDuration(file.url);
    if (file !== described) return;
    durationSec = seconds ? Math.round(seconds) : null;
    renderFile();
  }

  async function browse() {
    try {
      await useFile(await api.meetings.pickFile());
    } catch (err) {
      toastError(err);
    }
  }

  dropzone.addEventListener('click', browse);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      browse();
    }
  });
  fileCard.addEventListener('click', (e) => {
    if (e.target.closest('[data-change]')) browse();
  });
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-over');
    });
  }
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-over');
    const dropped = e.dataTransfer.files[0];
    if (!dropped) return;
    try {
      await useFile(await api.meetings.describeFile(api.system.pathForFile(dropped)));
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
  whenInput.addEventListener('input', refresh);

  saveButton.addEventListener('click', async () => {
    const when = new Date(whenInput.value);
    if (Number.isNaN(when.getTime())) {
      errorEl.textContent = 'Please enter when the meeting happened.';
      errorEl.hidden = false;
      return;
    }
    try {
      const meeting = await withBusy(saveButton, 'Saving…', () =>
        importMeeting({
          sourcePath: file.path,
          customerId: picker.value,
          title: body.querySelector('[name="title"]').value.trim(),
          startedAt: when.toISOString(),
          durationSec: durationSec || 0,
          notes: body.querySelector('[name="notes"]').value,
        }),
      );
      toast(`Meeting saved as ${meeting.fileName}`);
      modal.close();
      onSaved?.(meeting);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  refresh();
}
