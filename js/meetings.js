/* Meetings screen: search, filters and the list of recorded / uploaded meetings. */

import { esc, avatar, plural, fmtDuration, fmtTime } from './utils.js';
import { icon } from './icons.js';
import { getCustomer, sortedCustomers, meetingsNewestFirst, followupsForMeeting } from './store.js';

const filters = { q: '', customerId: '', source: 'all' };

export const getMeetingsFilter = () => ({ ...filters });

export function setMeetingsFilter(patch) {
  Object.assign(filters, patch);
}

function matches(meeting, q) {
  if (filters.customerId && meeting.customerId !== filters.customerId) return false;
  if (filters.source !== 'all' && meeting.source !== filters.source) return false;
  if (!q) return true;
  const customer = getCustomer(meeting.customerId);
  return [
    meeting.title,
    customer?.name,
    customer?.company,
    meeting.notes,
    meeting.fileName,
    ...(meeting.marks || []).map((m) => m.note),
  ].some((value) => (value || '').toLowerCase().includes(q));
}

function meetingRow(m) {
  const customer = getCustomer(m.customerId);
  const live = m.status === 'recording';
  const followups = followupsForMeeting(m.id);
  const done = followups.filter((f) => f.done).length;
  const start = new Date(m.startedAt);
  const missing = !live && !m.fileExists;
  return `
    <article class="meeting-row ${live ? 'is-live' : ''} ${missing ? 'is-missing' : ''}"
             data-action="${live ? 'open-recorder' : 'open-meeting'}" data-id="${m.id}" tabindex="0">
      <div class="date-chip">
        <span>${esc(start.toLocaleDateString(undefined, { month: 'short' }))}</span>
        <strong>${start.getDate()}</strong>
      </div>
      <div class="meeting-main">
        <div class="meeting-title">${esc(m.title)}</div>
        <div class="meeting-sub">
          ${avatar(customer, 'xs')}
          <span>${esc(customer?.name || 'Unknown customer')}${customer?.company ? ` · ${esc(customer.company)}` : ''}</span>
          <span class="dot"></span>
          <span>${esc(start.toLocaleDateString(undefined, { weekday: 'short' }))}, ${esc(fmtTime(m.startedAt))}</span>
        </div>
      </div>
      <div class="meeting-stats">
        ${live
          ? '<span class="live-pill"><span class="rec-dot"></span>Recording · <span data-rec-timer>00:00</span></span>'
          : `
            <span class="stat-pill" title="Length">${icon('clock', 13)} ${esc(m.durationSec ? fmtDuration(m.durationSec) : '—')}</span>
            <span class="stat-pill ${m.marks?.length ? '' : 'is-zero'}" title="Key moments">${icon('flag', 13)} ${m.marks?.length || 0}</span>
            <span class="stat-pill ${followups.length ? '' : 'is-zero'}" title="Follow-ups done">${icon('list-checks', 13)} ${done}/${followups.length}</span>
            ${missing
              ? '<span class="tag tag-danger">File missing</span>'
              : `<span class="source-badge source-${m.source}">${m.source === 'uploaded' ? 'Uploaded' : 'Recorded'}</span>`}`}
      </div>
      <div class="meeting-actions">
        ${live
          ? `<button type="button" class="btn btn-rec btn-sm" data-action="open-recorder">${icon('maximize', 14)} Open</button>`
          : `
            <button type="button" class="icon-btn play-mini" data-action="play-meeting" data-id="${m.id}" title="Play" ${missing ? 'disabled' : ''}>${icon('play-fill', 15)}</button>
            <button type="button" class="icon-btn" data-action="meeting-menu" data-id="${m.id}" title="More actions">${icon('more', 18)}</button>`}
      </div>
    </article>`;
}

function renderList(container) {
  const listEl = container.querySelector('[data-list]');
  const all = meetingsNewestFirst();
  const q = filters.q.trim().toLowerCase();
  const items = all.filter((m) => matches(m, q));
  container.querySelector('[data-count]').textContent = all.length
    ? items.length === all.length
      ? plural(all.length, 'meeting')
      : `${items.length} of ${all.length}`
    : '';

  if (!all.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-art">${icon('mic', 34)}</div>
        <h3>No meetings yet</h3>
        <p>Record a meeting live, or upload a recording you already have. Every file is saved as
          <code>CustomerName_timestamp</code> in your Recordings folder.</p>
        <div class="empty-actions">
          <button type="button" class="btn btn-secondary" data-action="upload">${icon('upload', 16)} Upload meeting</button>
          <button type="button" class="btn btn-rec" data-action="record">${icon('record-fill', 14)} Record now</button>
        </div>
      </div>`;
    return;
  }

  if (!items.length) {
    listEl.innerHTML = `
      <div class="empty empty-sm">
        <div class="empty-art">${icon('search', 28)}</div>
        <h3>No meetings match</h3>
        <p>Try a different search, or clear the filters.</p>
        <div class="empty-actions">
          <button type="button" class="btn btn-soft" data-clear-filters>Clear filters</button>
        </div>
      </div>`;
    return;
  }

  const groups = new Map();
  for (const m of items) {
    const date = new Date(m.startedAt);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (!groups.has(key)) {
      groups.set(key, { label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), items: [] });
    }
    groups.get(key).items.push(m);
  }
  listEl.innerHTML = [...groups.values()]
    .map(
      (g) => `
      <section class="month-group">
        <div class="month-label"><span>${esc(g.label)}</span><small>${plural(g.items.length, 'meeting')}</small></div>
        <div class="meeting-list">${g.items.map(meetingRow).join('')}</div>
      </section>`,
    )
    .join('');
}

function renderToolbar(container) {
  const select = container.querySelector('[data-filter="customerId"]');
  if (filters.customerId && !getCustomer(filters.customerId)) filters.customerId = '';
  select.innerHTML = `
    <option value="">All customers</option>
    ${sortedCustomers().map((c) => `<option value="${c.id}" ${c.id === filters.customerId ? 'selected' : ''}>${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('')}`;
  container.querySelector('.select-customer').classList.toggle('is-filtered', Boolean(filters.customerId));
  for (const button of container.querySelectorAll('[data-source]')) {
    button.classList.toggle('is-active', button.dataset.source === filters.source);
  }
  const search = container.querySelector('[data-filter="q"]');
  if (search.value !== filters.q) search.value = filters.q;
}

export function renderMeetings(container) {
  if (container.dataset.view !== 'meetings') {
    container.dataset.view = 'meetings';
    container.innerHTML = `
      <div class="toolbar">
        <div class="search-box">
          ${icon('search', 16)}
          <input class="input" type="search" data-filter="q" placeholder="Search titles, customers, notes and key moments…" />
        </div>
        <div class="select-wrap select-customer">
          ${icon('users', 15, 'select-lead')}
          <select class="input" data-filter="customerId" aria-label="Filter by customer"></select>
          ${icon('chevron-down', 16)}
        </div>
        <div class="segmented" role="group" aria-label="Filter by source">
          <button type="button" data-source="all">All</button>
          <button type="button" data-source="recorded">${icon('mic', 13)} Recorded</button>
          <button type="button" data-source="uploaded">${icon('upload', 13)} Uploaded</button>
        </div>
        <span class="toolbar-count" data-count></span>
      </div>
      <div data-list></div>`;

    container.querySelector('[data-filter="q"]').addEventListener('input', (e) => {
      filters.q = e.target.value;
      renderList(container);
    });
    container.querySelector('[data-filter="customerId"]').addEventListener('change', (e) => {
      filters.customerId = e.target.value;
      renderToolbar(container);
      renderList(container);
    });
    container.querySelector('.segmented').addEventListener('click', (e) => {
      const button = e.target.closest('[data-source]');
      if (!button) return;
      filters.source = button.dataset.source;
      renderToolbar(container);
      renderList(container);
    });
    container.querySelector('[data-list]').addEventListener('click', (e) => {
      if (!e.target.closest('[data-clear-filters]')) return;
      Object.assign(filters, { q: '', customerId: '', source: 'all' });
      renderToolbar(container);
      renderList(container);
    });
  }
  renderToolbar(container);
  renderList(container);
}
