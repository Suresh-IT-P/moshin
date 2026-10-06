/* Meeting details drawer: audio player with key moments, notes and follow-ups. */

import {
  el,
  esc,
  avatar,
  plural,
  fmtClock,
  fmtDuration,
  fmtBytes,
  fmtTime,
  fmtLongDate,
  toLocalInputValue,
  debounce,
  isTyping,
  isMac,
  revealLabel,
} from './utils.js';
import { icon } from './icons.js';
import {
  state,
  subscribe,
  getCustomer,
  getMeeting,
  followupsForMeeting,
  updateMeeting,
  deleteMeeting,
  createFollowup,
} from './store.js';
import { openModal, toast, toastError, confirmDialog, dueField, withBusy } from './ui.js';
import { pickCustomer } from './customers.js';
import { followupItem } from './followups.js';
import { openRecorder } from './recorder.js';

const api = window.api;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
let current = null;

/** Delete a meeting after confirmation. `release` lets an open player let go of the file first. */
export async function removeMeeting(meeting, { release } = {}) {
  const followups = followupsForMeeting(meeting.id).length;
  const ok = await confirmDialog({
    title: 'Delete this meeting?',
    message: `“${meeting.title}”${followups ? ` and its ${plural(followups, 'follow-up')}` : ''} will be removed. The recording is moved to the ${isMac() ? 'Trash' : 'Recycle Bin'}, so the audio can still be recovered.`,
    confirmLabel: 'Delete meeting',
    danger: true,
  });
  if (!ok) return false;
  release?.();
  try {
    await deleteMeeting(meeting.id);
    toast('Meeting deleted');
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

export function openEditMeeting(meeting) {
  const form = el(`
    <form class="form" novalidate>
      <div class="field">
        <label for="em-title">Meeting title</label>
        <input id="em-title" class="input" name="title" maxlength="200" value="${esc(meeting.title)}" autofocus />
      </div>
      <div class="field">
        <label>Customer</label>
        <div data-slot="customer"></div>
      </div>
      <div class="field">
        <label for="em-when">Date &amp; time</label>
        <input id="em-when" class="input" type="datetime-local" name="when" value="${toLocalInputValue(new Date(meeting.startedAt))}" />
      </div>
      <p class="hint">${icon('info', 13)} The audio file keeps its name: <code>${esc(meeting.fileName)}</code></p>
      <p class="form-error" hidden></p>
    </form>`);
  const picker = pickCustomer({ value: meeting.customerId });
  form.querySelector('[data-slot="customer"]').append(picker.el);

  const modal = openModal({
    title: 'Edit meeting',
    body: form,
    footer: `
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
      <button type="button" class="btn btn-primary" data-save>${icon('check', 16)} Save changes</button>`,
  });
  modal.onCleanup(picker.destroy);
  const errorEl = form.querySelector('.form-error');
  const save = modal.footer.querySelector('[data-save]');

  async function submit() {
    const title = form.querySelector('[name="title"]').value.trim();
    const when = new Date(form.querySelector('[name="when"]').value);
    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
    };
    if (!title) return showError('Please give the meeting a title.');
    if (!picker.value) return showError('Please choose a customer.');
    if (Number.isNaN(when.getTime())) return showError('Please enter a valid date and time.');
    try {
      await withBusy(save, 'Saving…', () =>
        updateMeeting(meeting.id, { title, customerId: picker.value, startedAt: when.toISOString() }),
      );
      toast('Meeting updated');
      modal.close();
    } catch (err) {
      showError(err.message);
    }
  }
  save.addEventListener('click', submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
}

export function openMeetingDetail(id, { autoplay = false } = {}) {
  const initial = getMeeting(id);
  if (!initial) return;
  if (initial.status === 'recording') {
    openRecorder();
    return;
  }
  current?.close();

  let marks = structuredClone(initial.marks || []);
  const audio = new Audio();
  audio.preload = 'auto';
  let speedIndex = 0;
  let dragging = false;
  let raf = 0;
  let activeMarkId = null;
  let durationChecked = false;

  const body = el(`
    <div class="md">
      <div class="md-head" data-head></div>
      <div class="md-scroll">
        <section class="player" data-player>
          <div class="player-row">
            <button type="button" class="play-btn" data-act="toggle" aria-label="Play" autofocus>${icon('play-fill', 22)}</button>
            <div class="player-mid">
              <div class="track" data-track>
                <div class="track-rail"><div class="track-fill" data-fill></div></div>
                <div class="track-marks" data-track-marks></div>
                <div class="track-thumb" data-thumb></div>
                <div class="track-hover" data-hover></div>
              </div>
              <div class="player-times"><span data-cur>00:00</span><span data-dur>00:00</span></div>
            </div>
          </div>
          <div class="player-tools">
            <button type="button" class="chip-btn" data-act="back" title="Back 15 seconds">${icon('rotate-ccw', 14)} 15s</button>
            <button type="button" class="chip-btn" data-act="fwd" title="Forward 15 seconds">15s ${icon('rotate-cw', 14)}</button>
            <button type="button" class="chip-btn chip-speed" data-act="speed" title="Playback speed">1×</button>
            <span class="player-hint"><kbd>Space</kbd> play / pause · <kbd>←</kbd> <kbd>→</kbd> skip 5s</span>
          </div>
          <div class="callout callout-warning" data-player-error hidden></div>
        </section>

        <section class="md-section">
          <div class="md-section-head">
            <h3>${icon('flag', 16)} Key moments <span class="count" data-marks-count></span></h3>
            <button type="button" class="btn btn-soft btn-sm" data-act="add-mark">${icon('plus', 14)} Mark at <span data-now>00:00</span></button>
          </div>
          <div data-marks></div>
        </section>

        <section class="md-section">
          <div class="md-section-head">
            <h3>${icon('notes', 16)} Notes</h3>
            <span class="save-state" data-save-state></span>
          </div>
          <textarea class="input notes-area" data-notes rows="6" placeholder="Key points, decisions, numbers, names…"></textarea>
        </section>

        <section class="md-section">
          <div class="md-section-head">
            <h3>${icon('list-checks', 16)} Follow-ups <span class="count" data-fu-count></span></h3>
          </div>
          <div class="fu-list" data-followups></div>
          <form class="quick-fu quick-fu-inline" novalidate>
            <input class="input" name="title" maxlength="300" placeholder="Add a follow-up from this meeting…" />
            <div data-slot="due"></div>
            <button type="submit" class="btn btn-primary btn-sm">${icon('plus', 15)} Add</button>
          </form>
        </section>

        <footer class="md-file" data-file></footer>
      </div>
    </div>`);

  const $ = (sel) => body.querySelector(sel);
  const track = $('[data-track]');
  const notes = $('[data-notes]');
  const saveState = $('[data-save-state]');
  const fuForm = body.querySelector('.quick-fu');
  const due = dueField({ compact: true });
  fuForm.querySelector('[data-slot="due"]').append(due.el);
  notes.value = initial.notes || '';

  const modal = openModal({ variant: 'drawer', body });
  current = modal;

  const meeting = () => getMeeting(id) || initial;
  const duration = () =>
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : meeting().durationSec || 0;

  /* ------------------------------------------------------------ rendering */

  function renderHead() {
    const m = meeting();
    const customer = getCustomer(m.customerId);
    const start = new Date(m.startedAt);
    $('[data-head]').innerHTML = `
      <div class="md-head-row">
        ${avatar(customer, 'lg')}
        <div class="md-title">
          <h2>${esc(m.title)}</h2>
          <p>${esc(customer?.name || 'Unknown customer')}${customer?.company ? ` · ${esc(customer.company)}` : ''}</p>
        </div>
        <div class="md-head-actions">
          <button type="button" class="icon-btn" data-act="edit" title="Edit details">${icon('pencil', 17)}</button>
          <button type="button" class="icon-btn" data-act="reveal" title="${revealLabel()}">${icon('folder-open', 17)}</button>
          <button type="button" class="icon-btn danger" data-act="delete" title="Delete meeting">${icon('trash', 17)}</button>
          <span class="divider"></span>
          <button type="button" class="icon-btn" data-modal-close title="Close">${icon('x', 18)}</button>
        </div>
      </div>
      <div class="md-facts">
        <span class="fact">${icon('calendar', 14)} ${esc(fmtLongDate(start))}</span>
        <span class="fact">${icon('clock', 14)} ${esc(fmtTime(m.startedAt))}</span>
        <span class="fact">${icon('waves', 14)} ${esc(m.durationSec ? fmtDuration(m.durationSec) : '—')}</span>
        <span class="source-badge source-${m.source}">${m.source === 'uploaded' ? `${icon('upload', 12)} Uploaded` : `${icon('mic', 12)} Recorded`}</span>
        ${m.recovered ? `<span class="tag tag-warning" title="The app closed while recording; the audio captured up to that point was kept.">Recovered</span>` : ''}
      </div>`;
    $('[data-file]').innerHTML = `
      <span class="md-file-icon">${icon('file-audio', 18)}</span>
      <div class="md-file-text">
        <strong>${esc(m.fileName)}</strong>
        <span>${m.fileExists ? esc(fmtBytes(m.sizeBytes)) : 'File missing'} · ${esc(state.info.display.recordings)}</span>
      </div>
      <button type="button" class="btn btn-soft btn-sm" data-act="reveal">${icon('folder-open', 15)} ${revealLabel()}</button>`;
  }

  function renderTrackMarks() {
    const total = duration();
    $('[data-track-marks]').innerHTML = total
      ? marks
          .map(
            (mk) => `<button type="button" class="track-mark ${mk.id === activeMarkId ? 'is-active' : ''}" data-mark="${mk.id}"
                      style="left:${Math.min(100, (mk.t / total) * 100)}%"
                      title="${esc(fmtClock(mk.t))}${mk.note ? ` · ${esc(mk.note)}` : ''}"></button>`,
          )
          .join('')
      : '';
  }

  function renderMarks() {
    $('[data-marks-count]').textContent = marks.length || '';
    $('[data-marks]').innerHTML = marks.length
      ? `<ol class="moment-list">
          ${marks
            .map(
              (mk) => `
            <li class="moment ${mk.id === activeMarkId ? 'is-current' : ''}" data-id="${mk.id}">
              <button type="button" class="moment-time" data-act="jump" title="Play from here">${icon('play-fill', 10)} ${fmtClock(mk.t)}</button>
              <input class="moment-note" value="${esc(mk.note)}" maxlength="500" placeholder="Add a note…" />
              <button type="button" class="icon-btn sm" data-act="remove-mark" title="Remove">${icon('x', 14)}</button>
            </li>`,
            )
            .join('')}
        </ol>`
      : `<div class="md-empty">${icon('flag', 18)}<span>No key moments yet. While listening, click <b>Mark at …</b> to bookmark the parts that matter.</span></div>`;
    renderTrackMarks();
  }

  function renderFollowups() {
    const list = followupsForMeeting(id);
    $('[data-fu-count]').textContent = list.length || '';
    $('[data-followups]').innerHTML = list.length
      ? list.map((f) => followupItem(f, { showCustomer: false, showMeeting: false })).join('')
      : '<p class="md-empty-line">No follow-ups yet.</p>';
  }

  function renderProgress() {
    const total = duration();
    const now = audio.currentTime || 0;
    const ratio = total ? Math.min(1, now / total) : 0;
    $('[data-fill]').style.width = `${ratio * 100}%`;
    $('[data-thumb]').style.left = `${ratio * 100}%`;
    $('[data-cur]').textContent = fmtClock(now);
    $('[data-dur]').textContent = fmtClock(total);
    $('[data-now]').textContent = fmtClock(now);

    // Highlight the moment currently playing.
    let active = null;
    for (const mk of marks) if (mk.t <= now + 0.25) active = mk.id;
    if (audio.paused && now === 0) active = null;
    if (active !== activeMarkId) {
      activeMarkId = active;
      for (const row of body.querySelectorAll('.moment')) row.classList.toggle('is-current', row.dataset.id === active);
      for (const tick of body.querySelectorAll('.track-mark')) tick.classList.toggle('is-active', tick.dataset.mark === active);
    }
  }

  function renderPlayButton() {
    const button = $('[data-act="toggle"]');
    button.innerHTML = icon(audio.paused ? 'play-fill' : 'pause-fill', 22);
    button.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
    button.classList.toggle('is-playing', !audio.paused);
  }

  function showPlayerError(html) {
    const box = $('[data-player-error]');
    box.innerHTML = html;
    box.hidden = false;
    $('[data-player]').classList.add('is-unavailable');
  }

  /* -------------------------------------------------------------- playback */

  function loop() {
    renderProgress();
    raf = audio.paused ? 0 : requestAnimationFrame(loop);
  }

  async function play() {
    try {
      await audio.play();
    } catch (err) {
      if (err.name !== 'AbortError') toastError(err);
    }
  }

  const toggle = () => (audio.paused ? play() : audio.pause());

  function seek(seconds) {
    const total = duration();
    audio.currentTime = Math.max(0, total ? Math.min(seconds, total - 0.05) : seconds);
    renderProgress();
  }

  function jumpTo(t) {
    seek(Math.max(0, t - 2)); // a little lead-in for context
    play();
  }

  const ratioAt = (e) => {
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  /** WebM files from other recorders may not store their length; ask the browser to work it out. */
  function resolveDuration() {
    if (durationChecked) return Promise.resolve();
    durationChecked = true;
    if (Number.isFinite(audio.duration)) {
      saveDurationIfNeeded();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        audio.removeEventListener('durationchange', check);
        clearTimeout(timer);
        audio.currentTime = 0;
        saveDurationIfNeeded();
        resolve();
      };
      const check = () => {
        if (Number.isFinite(audio.duration)) finish();
      };
      const timer = setTimeout(finish, 8000);
      audio.addEventListener('durationchange', check);
      audio.currentTime = 1e101;
    });
  }

  function saveDurationIfNeeded() {
    const real = Math.round(audio.duration);
    if (Number.isFinite(real) && real > 0 && Math.abs(real - (meeting().durationSec || 0)) > 2) {
      updateMeeting(id, { durationSec: real }).catch(() => {});
    }
  }

  function releaseAudio() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // lets go of the file so it can be moved to the Trash
  }

  audio.addEventListener('loadedmetadata', async () => {
    await resolveDuration();
    if (modal.closed) return;
    renderProgress();
    renderTrackMarks();
    if (autoplay) {
      autoplay = false;
      play();
    }
  });
  audio.addEventListener('play', () => {
    renderPlayButton();
    if (!raf) raf = requestAnimationFrame(loop);
  });
  audio.addEventListener('pause', renderPlayButton);
  audio.addEventListener('ended', renderPlayButton);
  audio.addEventListener('timeupdate', () => {
    if (!dragging && audio.paused) renderProgress();
  });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    showPlayerError(`
      ${icon('alert', 18)}
      <div><strong>This file can’t be played inside MeetMinder.</strong><p>It may use an unusual format. You can still open it with your default audio player.</p></div>
      <button type="button" class="btn btn-soft btn-sm" data-act="open-external">${icon('external', 14)} Open in default app</button>`);
  });

  if (initial.fileExists) {
    audio.src = initial.fileUrl;
  } else {
    showPlayerError(`
      ${icon('alert', 18)}
      <div><strong>Recording file not found.</strong><p>It may have been moved, renamed or deleted from the Recordings folder.</p></div>
      <button type="button" class="btn btn-soft btn-sm" data-act="reveal">${icon('folder-open', 14)} Open folder</button>`);
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.track-mark') || !duration()) return;
    dragging = true;
    track.setPointerCapture(e.pointerId);
    seek(ratioAt(e) * duration());
  });
  track.addEventListener('pointermove', (e) => {
    const hover = $('[data-hover]');
    const total = duration();
    if (total) {
      hover.textContent = fmtClock(ratioAt(e) * total);
      hover.style.left = `${ratioAt(e) * 100}%`;
    }
    if (dragging) seek(ratioAt(e) * total);
  });
  track.addEventListener('pointerup', () => {
    dragging = false;
  });
  track.addEventListener('pointercancel', () => {
    dragging = false;
  });

  /* ----------------------------------------------------------------- saving */

  const saveMarks = debounce(() => updateMeeting(id, { marks }).catch(toastError), 600);

  const saveNotes = debounce(async () => {
    try {
      await updateMeeting(id, { notes: notes.value });
      saveState.innerHTML = `${icon('check', 13)} Saved`;
      saveState.className = 'save-state is-saved';
    } catch (err) {
      saveState.textContent = 'Not saved';
      saveState.className = 'save-state is-error';
      toastError(err);
    }
  }, 700);

  function addMark() {
    const mark = {
      id: crypto.randomUUID(),
      t: Math.round((audio.currentTime || 0) * 10) / 10,
      note: '',
      createdAt: new Date().toISOString(),
    };
    marks = [...marks, mark].sort((a, b) => a.t - b.t);
    renderMarks();
    saveMarks();
    const input = body.querySelector(`.moment[data-id="${mark.id}"] .moment-note`);
    input?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    input?.focus();
  }

  /* ----------------------------------------------------------------- events */

  body.addEventListener('click', async (e) => {
    const tick = e.target.closest('[data-mark]');
    if (tick) {
      const mk = marks.find((m) => m.id === tick.dataset.mark);
      if (mk) jumpTo(mk.t);
      return;
    }
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const m = meeting();
    switch (button.dataset.act) {
      case 'toggle':
        return toggle();
      case 'back':
        return seek(audio.currentTime - 15);
      case 'fwd':
        return seek(audio.currentTime + 15);
      case 'speed':
        speedIndex = (speedIndex + 1) % SPEEDS.length;
        audio.playbackRate = SPEEDS[speedIndex];
        button.textContent = `${SPEEDS[speedIndex]}×`;
        button.classList.toggle('is-active', speedIndex > 0);
        return;
      case 'add-mark':
        return addMark();
      case 'jump': {
        const mk = marks.find((x) => x.id === button.closest('.moment').dataset.id);
        if (mk) jumpTo(mk.t);
        return;
      }
      case 'remove-mark':
        marks = marks.filter((x) => x.id !== button.closest('.moment').dataset.id);
        renderMarks();
        saveMarks();
        return;
      case 'edit':
        return openEditMeeting(m);
      case 'reveal':
        return api.meetings.reveal(id).catch(toastError);
      case 'open-external':
        return api.meetings.openExternal(id).catch(toastError);
      case 'delete':
        if (await removeMeeting(m, { release: releaseAudio })) modal.close();
        return;
      default:
    }
  });

  body.addEventListener('input', (e) => {
    if (e.target === notes) {
      saveState.textContent = 'Saving…';
      saveState.className = 'save-state';
      saveNotes();
    } else if (e.target.classList.contains('moment-note')) {
      const mk = marks.find((x) => x.id === e.target.closest('.moment').dataset.id);
      if (mk) {
        mk.note = e.target.value;
        saveMarks();
      }
    }
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('moment-note')) e.target.blur();
  });
  body.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('moment-note')) renderTrackMarks(); // refresh tooltips
  });

  fuForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = fuForm.querySelector('[name="title"]');
    const title = input.value.trim();
    if (!title) return input.focus();
    try {
      await createFollowup({ title, dueDate: due.value, meetingId: id });
      input.value = '';
      toast('Follow-up added');
    } catch (err) {
      toastError(err);
    }
  });

  const onKey = (e) => {
    if (!modal.isTop() || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(audio.currentTime - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(audio.currentTime + 5);
    }
  };
  document.addEventListener('keydown', onKey);

  const unsubscribe = subscribe(() => {
    if (!getMeeting(id)) {
      modal.close();
      return;
    }
    renderHead();
    renderFollowups();
  });

  modal.onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    unsubscribe();
    cancelAnimationFrame(raf);
    saveMarks.flush();
    saveNotes.flush();
    releaseAudio();
    if (current === modal) current = null;
  });

  renderHead();
  renderMarks();
  renderFollowups();
  renderProgress();
}
