/* App shell: navigation between Dashboard and Meetings, top-bar actions and global wiring. */

import { $, $$, esc, plural, fmtHours, todayKey, revealLabel } from './utils.js';
import { icon, hydrateIcons } from './icons.js';
import { state, subscribe, replaceAll, getMeeting, getFollowup } from './store.js';
import { toast, toastError, openMenu } from './ui.js';
import { openCustomerForm, openCustomersList } from './customers.js';
import { openFollowupForm, toggleFollowup, removeFollowup, followupBuckets } from './followups.js';
import { renderDashboard, setDashboardTab } from './dashboard.js';
import { renderMeetings, setMeetingsFilter, getMeetingsFilter } from './meetings.js';
import { startRecordingFlow, openRecorder, stopRecording, configureRecorder, onSessionChange, isRecording } from './recorder.js';
import { openMeetingDetail, openEditMeeting, removeMeeting } from './meeting-detail.js';
import { openUploadModal } from './upload.js';

const api = window.api;
let current = 'dashboard';

const VIEWS = {
  dashboard: {
    title: 'Dashboard',
    subtitle: () => 'Your customers, meetings and follow-ups at a glance',
    actions: () => `
      <button type="button" class="btn btn-primary" data-action="add-customer">${icon('user-plus', 16)} Add Customer</button>`,
    render: renderDashboard,
  },
  meetings: {
    title: 'Meetings',
    subtitle: () => {
      const total = state.meetings.reduce((sum, m) => sum + (m.durationSec || 0), 0);
      return state.meetings.length
        ? `${plural(state.meetings.length, 'meeting')} · ${fmtHours(total)} recorded`
        : 'Record live, or upload a recording you already have';
    },
    actions: () => `
      <button type="button" class="btn btn-secondary" data-action="upload">${icon('upload', 16)} Upload Meeting</button>
      ${isRecording()
        ? `<button type="button" class="btn btn-rec is-live" data-action="open-recorder"><span class="rec-dot"></span> Recording · <span data-rec-timer>00:00</span></button>`
        : `<button type="button" class="btn btn-rec" data-action="record">${icon('record-fill', 14)} Record Now</button>`}`,
    render: renderMeetings,
  },
};

/* ------------------------------------------------------------------ render */

function renderTopbar() {
  const view = VIEWS[current];
  $('#page-title').textContent = view.title;
  $('#page-subtitle').textContent = view.subtitle();
  $('#page-actions').innerHTML = view.actions();
}

function renderNav() {
  for (const item of $$('[data-nav]')) item.classList.toggle('is-active', item.dataset.nav === current);
  const buckets = followupBuckets();
  const urgent = buckets.today.length + buckets.overdue.length;
  const dashBadge = $('#nav-badge-dashboard');
  dashBadge.hidden = !urgent;
  dashBadge.textContent = urgent;
  dashBadge.title = `${plural(urgent, 'follow-up')} due today or overdue`;
  const meetBadge = $('#nav-badge-meetings');
  meetBadge.hidden = !state.meetings.length;
  meetBadge.textContent = state.meetings.length;
}

function render() {
  renderTopbar();
  VIEWS[current].render($('#content'));
  renderNav();
}

function navigate(view, { customerId } = {}) {
  if (!VIEWS[view]) return;
  if (customerId !== undefined) setMeetingsFilter({ customerId, q: '', source: 'all' });
  const changed = view !== current;
  current = view;
  render();
  if (changed || customerId !== undefined) $('#content').scrollTop = 0;
}

/* ----------------------------------------------------------------- actions */

const contextCustomer = () => (current === 'meetings' ? getMeetingsFilter().customerId || null : null);

function meetingMenu(anchor) {
  const meeting = getMeeting(anchor.dataset.id);
  if (!meeting) return;
  openMenu(anchor, [
    { label: 'Open', icon: 'arrow-right', onClick: () => openMeetingDetail(meeting.id) },
    { label: 'Play', icon: 'play-fill', onClick: () => openMeetingDetail(meeting.id, { autoplay: true }) },
    { label: 'Edit details', icon: 'pencil', onClick: () => openEditMeeting(meeting) },
    { label: 'Add follow-up', icon: 'list-checks', onClick: () => openFollowupForm({ meetingId: meeting.id }) },
    { label: revealLabel(), icon: 'folder-open', onClick: () => api.meetings.reveal(meeting.id).catch(toastError) },
    '-',
    { label: 'Delete meeting', icon: 'trash', danger: true, onClick: () => removeMeeting(meeting) },
  ]);
}

const actions = {
  'add-customer': () => openCustomerForm(),
  'open-customers': () => openCustomersList({ onViewMeetings: (id) => navigate('meetings', { customerId: id }) }),
  'customer-meetings': (node) => navigate('meetings', { customerId: node.dataset.id }),
  record: () => startRecordingFlow({ customerId: contextCustomer() }),
  'open-recorder': () => openRecorder(),
  upload: () => openUploadModal({ customerId: contextCustomer(), onSaved: (m) => openMeetingDetail(m.id) }),
  'open-meeting': (node) => openMeetingDetail(node.dataset.id),
  'play-meeting': (node) => openMeetingDetail(node.dataset.id, { autoplay: true }),
  'meeting-menu': (node) => meetingMenu(node),
  'go-meetings': () => navigate('meetings', { customerId: '' }),
  'add-followup': () => openFollowupForm(),
  'toggle-followup': (node) => toggleFollowup(node.dataset.id, node),
  'edit-followup': (node) => openFollowupForm({ followup: getFollowup(node.dataset.id) }),
  'delete-followup': (node) => removeFollowup(node.dataset.id),
  'followup-tab': (node) => {
    setDashboardTab(node.dataset.tab);
    render();
  },
  'show-followups': () => {
    setDashboardTab(followupBuckets().overdue.length ? 'overdue' : 'today');
    render();
    $('#followups-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'open-folder': () => api.system.openRecordings().catch(toastError),
};

document.addEventListener('click', (e) => {
  const node = e.target.closest('[data-action]');
  if (!node || node.disabled) return;
  const handler = actions[node.dataset.action];
  if (!handler) return;
  e.preventDefault();
  handler(node, e);
});

// Meeting rows are focusable: Enter opens them.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('article[data-action]')) e.target.click();
});

// Never let a dropped file replace the app window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* -------------------------------------------------------------------- boot */

async function boot() {
  const info = await api.app.info();
  state.info = info;
  document.body.dataset.platform = info.platform;
  hydrateIcons();
  $('#storage-path').textContent = info.display.recordings;
  $('#storage-path').title = info.dirs.recordings;

  replaceAll(await api.data.load());
  configureRecorder({ onOpenMeeting: (id) => openMeetingDetail(id) });
  subscribe(render);
  onSessionChange(renderTopbar);

  for (const item of $$('[data-nav]')) item.addEventListener('click', () => navigate(item.dataset.nav));

  api.on('menu:navigate', (view) => navigate(view));
  api.on('menu:record', () => actions.record());
  api.on('menu:upload', () => actions.upload());
  api.on('menu:add-customer', () => openCustomerForm());
  api.on('recording:stop-request', async () => {
    try {
      await stopRecording({ openAfter: false });
    } finally {
      api.app.stoppedForClose();
    }
  });

  // Follow-up windows depend on the date: refresh when the day changes.
  let day = todayKey();
  setInterval(() => {
    if (todayKey() !== day) {
      day = todayKey();
      render();
    }
  }, 60 * 1000);

  navigate('dashboard');
  document.body.classList.add('is-ready');

  if (info.recovered) {
    toast(`Recovered ${plural(info.recovered, 'recording')} that was still running when the app closed.`, {
      type: 'info',
      duration: 9000,
    });
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre class="fatal">MeetMinder could not start.\n\n${esc(err.stack || err.message)}</pre>`;
});
