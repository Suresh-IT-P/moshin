/* Dashboard: today's summary, key numbers, follow-ups and recent meetings. */

import { esc, avatar, plural, greeting, fmtLongDate, fmtHours, fmtDuration, fmtDayTime, todayKey, toDateKey } from './utils.js';
import { icon } from './icons.js';
import { state, getCustomer, meetingsNewestFirst } from './store.js';
import { followupBuckets, followupItem } from './followups.js';

const TABS = [
  { key: 'today', label: 'Today', empty: ['Nothing due today', 'You’re all caught up for today.'] },
  { key: 'week', label: 'This Week', empty: ['A clear week ahead', 'No follow-ups due between today and Sunday.'] },
  { key: 'ten', label: 'Within 10 Days', empty: ['Nothing in the next 10 days', 'Follow-ups due soon will appear here.'] },
  { key: 'month', label: 'This Month', empty: ['Nothing else this month', 'No follow-ups due before the month ends.'] },
];

let activeTab = 'today';

export function setDashboardTab(key) {
  activeTab = key;
}

const WAVE_ART = `
  <svg viewBox="0 0 240 120" fill="none" aria-hidden="true">
    ${[18, 34, 58, 82, 46, 96, 70, 108, 60, 88, 40, 74, 28, 52, 20]
      .map((h, i) => `<rect x="${8 + i * 15.5}" y="${60 - h / 2}" width="7" height="${h}" rx="3.5" fill="currentColor" opacity="${0.35 + (i % 4) * 0.15}"/>`)
      .join('')}
  </svg>`;

function hero(buckets) {
  const parts = [];
  if (buckets.today.length) parts.push(`<b>${plural(buckets.today.length, 'follow-up')}</b> due today`);
  if (buckets.overdue.length) parts.push(`<b class="hero-alert">${buckets.overdue.length} overdue</b>`);
  let summary;
  if (parts.length) summary = `You have ${parts.join(' and ')}. Let’s keep every promise.`;
  else if (!state.meetings.length) summary = 'Record your first customer meeting — MeetMinder keeps the audio, the key moments and every follow-up.';
  else summary = 'Nothing due today — you’re all caught up. ✨';

  return `
    <section class="hero">
      <div class="hero-text">
        <span class="hero-date">${icon('calendar', 14)} ${esc(fmtLongDate())}</span>
        <h2>${greeting()} 👋</h2>
        <p>${summary}</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="btn btn-white" data-action="record">${icon('record-fill', 14, 'text-rec')} Record a meeting</button>
        <button type="button" class="btn btn-glass" data-action="add-followup">${icon('plus', 16)} Add follow-up</button>
      </div>
      <div class="hero-art">${WAVE_ART}</div>
    </section>`;
}

function stat({ action, tone, iconName, label, value, meta }) {
  return `
    <button type="button" class="stat stat-${tone}" data-action="${action}">
      <span class="stat-icon">${icon(iconName, 20)}</span>
      <span class="stat-body">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
        <span class="stat-meta">${meta}</span>
      </span>
      <span class="stat-go">${icon('chevron-right', 16)}</span>
    </button>`;
}

function followupsCard(buckets) {
  if (activeTab === 'overdue' && !buckets.overdue.length) activeTab = 'today';
  const list = buckets[activeTab];
  const tab = TABS.find((t) => t.key === activeTab);

  let content;
  if (list.length) {
    content = list.map((f) => followupItem(f)).join('');
  } else if (!state.followups.length) {
    content = `
      <div class="fu-empty">
        <span class="fu-empty-icon">${icon('list-checks', 22)}</span>
        <strong>No follow-ups yet</strong>
        <p>While recording or reviewing a meeting, add what you promised with a due date. It will show up right here.</p>
        <button type="button" class="btn btn-soft btn-sm" data-action="add-followup">${icon('plus', 15)} Add your first follow-up</button>
      </div>`;
  } else {
    content = `
      <div class="fu-empty">
        <span class="fu-empty-icon">${icon('sparkles', 22)}</span>
        <strong>${esc(tab.empty[0])}</strong>
        <p>${esc(tab.empty[1])}</p>
      </div>`;
  }

  return `
    <section class="card fu-card" id="followups-card">
      <div class="card-head">
        <div>
          <h3>Follow-ups</h3>
          <p>What you promised, and when it’s due.</p>
        </div>
        <button type="button" class="btn btn-soft btn-sm" data-action="add-followup">${icon('plus', 15)} Add follow-up</button>
      </div>
      ${buckets.overdue.length ? `
        <button type="button" class="overdue-banner ${activeTab === 'overdue' ? 'is-active' : ''}" data-action="followup-tab" data-tab="overdue">
          ${icon('alert', 16)}
          <span><b>${plural(buckets.overdue.length, 'follow-up')} overdue</b> — these slipped past their due date</span>
          <span class="overdue-link">${activeTab === 'overdue' ? 'Showing below' : 'Review'} ${icon('arrow-right', 14)}</span>
        </button>` : ''}
      <div class="tabs" role="tablist">
        ${TABS.map(
          (t) => `
          <button type="button" class="tab ${activeTab === t.key ? 'is-active' : ''}" data-action="followup-tab" data-tab="${t.key}" role="tab" aria-selected="${activeTab === t.key}">
            ${t.label}<span class="tab-count">${buckets[t.key].length}</span>
          </button>`,
        ).join('')}
      </div>
      <div class="fu-list">${content}</div>
    </section>`;
}

function recentCard() {
  const recent = meetingsNewestFirst().slice(0, 5);
  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h3>Recent meetings</h3>
          <p>Pick up where you left off.</p>
        </div>
        <button type="button" class="link-btn" data-action="go-meetings">View all ${icon('arrow-right', 14)}</button>
      </div>
      ${recent.length ? `
        <div class="recent-list">
          ${recent
            .map((m) => {
              const customer = getCustomer(m.customerId);
              const live = m.status === 'recording';
              return `
                <button type="button" class="recent-item" data-action="${live ? 'open-recorder' : 'open-meeting'}" data-id="${m.id}">
                  ${avatar(customer, 'md')}
                  <span class="recent-text">
                    <strong>${esc(m.title)}</strong>
                    <small>${esc(customer?.name || 'Unknown')} · ${esc(fmtDayTime(m.startedAt))}</small>
                  </span>
                  ${live
                    ? '<span class="live-pill"><span class="rec-dot"></span>Live</span>'
                    : `<span class="pill">${esc(m.durationSec ? fmtDuration(m.durationSec) : '—')}</span>`}
                </button>`;
            })
            .join('')}
        </div>` : `
        <div class="mini-empty">
          <p>No meetings yet.</p>
          <button type="button" class="btn btn-rec btn-sm" data-action="record">${icon('record-fill', 12)} Record now</button>
        </div>`}
    </section>`;
}

function customersCard() {
  const counts = new Map();
  for (const m of state.meetings) counts.set(m.customerId, (counts.get(m.customerId) || 0) + 1);
  const top = [...state.customers]
    .sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.name.localeCompare(b.name))
    .slice(0, 5);
  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h3>Customers</h3>
          <p>The people you meet most.</p>
        </div>
        <button type="button" class="link-btn" data-action="open-customers">Manage ${icon('arrow-right', 14)}</button>
      </div>
      ${top.length ? `
        <div class="cust-mini-list">
          ${top
            .map(
              (c) => `
            <button type="button" class="cust-mini" data-action="customer-meetings" data-id="${c.id}" title="View meetings with ${esc(c.name)}">
              ${avatar(c, 'sm')}
              <span class="cust-mini-text"><strong>${esc(c.name)}</strong><small>${esc(c.company || 'No company')}</small></span>
              <span class="pill">${icon('mic', 12)} ${counts.get(c.id) || 0}</span>
            </button>`,
            )
            .join('')}
        </div>` : `
        <div class="mini-empty">
          <p>No customers yet.</p>
          <button type="button" class="btn btn-primary btn-sm" data-action="add-customer">${icon('user-plus', 14)} Add customer</button>
        </div>`}
    </section>`;
}

export function renderDashboard(container) {
  container.dataset.view = 'dashboard';
  const buckets = followupBuckets();
  const month = todayKey().slice(0, 7);
  const inThisMonth = (iso) => toDateKey(new Date(iso)).startsWith(month);

  const meetings = state.meetings;
  const totalSeconds = meetings.reduce((sum, m) => sum + (m.durationSec || 0), 0);
  const timed = meetings.filter((m) => m.durationSec > 0).length;
  const newCustomers = state.customers.filter((c) => inThisMonth(c.createdAt)).length;
  const meetingsThisMonth = meetings.filter((m) => inThisMonth(m.startedAt)).length;

  let followupMeta = 'All caught up';
  if (buckets.overdue.length) followupMeta = `<b class="down">${buckets.overdue.length} overdue</b>`;
  else if (buckets.today.length) followupMeta = `<b>${buckets.today.length}</b> due today`;

  container.innerHTML = `
    ${hero(buckets)}
    <div class="stats">
      ${stat({
        action: 'open-customers',
        tone: 'indigo',
        iconName: 'users',
        label: 'Customers',
        value: state.customers.length,
        meta: newCustomers ? `<b class="up">+${newCustomers}</b> added this month` : 'View all customers',
      })}
      ${stat({
        action: 'go-meetings',
        tone: 'pink',
        iconName: 'mic',
        label: 'Meetings attended',
        value: meetings.length,
        meta: `<b>${meetingsThisMonth}</b> this month`,
      })}
      ${stat({
        action: 'show-followups',
        tone: 'amber',
        iconName: 'list-checks',
        label: 'Pending follow-ups',
        value: buckets.pending.length,
        meta: followupMeta,
      })}
      ${stat({
        action: 'go-meetings',
        tone: 'teal',
        iconName: 'clock',
        label: 'Time recorded',
        value: fmtHours(totalSeconds),
        meta: timed ? `avg <b>${fmtDuration(totalSeconds / timed)}</b> per meeting` : 'No recordings yet',
      })}
    </div>
    <div class="dash-grid">
      ${followupsCard(buckets)}
      <div class="dash-side">
        ${recentCard()}
        ${customersCard()}
      </div>
    </div>`;
}
