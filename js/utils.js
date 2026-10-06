/* Small helpers shared by every screen. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape user text before putting it into HTML. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Build a DOM element from an HTML string. */
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export const pad = (n) => String(n).padStart(2, '0');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/* ------------------------------------------------------------- dates (local) */
// Follow-up due dates are stored as local "YYYY-MM-DD" keys, so string comparison works.

export const toDateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayKey = () => toDateKey(new Date());

export function addDays(key, days) {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** Weeks run Monday → Sunday. */
export function endOfWeek(key) {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + ((7 - date.getDay()) % 7));
  return toDateKey(date);
}

export function nextMonday(key) {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + (((8 - date.getDay()) % 7) || 7));
  return toDateKey(date);
}

export function endOfMonth(key) {
  const date = fromDateKey(key);
  return toDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export const dayDiff = (fromKey, toKey) => Math.round((fromDateKey(toKey) - fromDateKey(fromKey)) / 86400000);

/** "Today", "Tomorrow", "Friday", "Oct 18", "3 days overdue" */
export function dueLabel(key) {
  const diff = dayDiff(todayKey(), key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) return diff === -1 ? '1 day overdue' : `${-diff} days overdue`;
  if (diff < 7) return fromDateKey(key).toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = key.slice(0, 4) === todayKey().slice(0, 4);
  return fromDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function dueTone(key) {
  const diff = dayDiff(todayKey(), key);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff <= 2) return 'soon';
  return 'later';
}

export const fmtLongDate = (date = new Date()) =>
  date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function fmtDate(iso, withYear = true) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

/** "Today", "Yesterday", "Monday", "Oct 2" (+ year when needed). */
export function fmtDay(iso) {
  const date = new Date(iso);
  const diff = dayDiff(toDateKey(date), todayKey());
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return fmtDate(iso, date.getFullYear() !== new Date().getFullYear());
}

export const fmtDayTime = (iso) => `${fmtDay(iso)}, ${fmtTime(iso)}`;

export function toLocalInputValue(date) {
  return `${toDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/* -------------------------------------------------------------- durations */

/** 01:23:45 or 12:03 */
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** 1h 05m · 4m 09s · 12s */
export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** 12h 40m · 45m · 38s (for totals) */
export function fmtHours(totalSeconds) {
  const seconds = Math.round(totalSeconds || 0);
  if (seconds > 0 && seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${pad(minutes % 60)}m` : `${minutes}m`;
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/* ------------------------------------------------------------------ people */

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0]);
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1]) : [];
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

const AVATAR_HUES = [243, 262, 330, 199, 160, 24, 282, 188, 350, 142, 45, 215];

export function avatarHue(seed = '') {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length];
}

export function avatar(customer, size = 'md') {
  const name = customer?.name || '?';
  return `<span class="avatar avatar-${size}" style="--av-h:${avatarHue(customer?.id || name)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

/** Same rule the main process uses for recording file names. */
export function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60);
  return cleaned || 'Customer';
}

export function fileStamp(date = new Date()) {
  return `${toDateKey(date)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------- misc */

export function debounce(fn, wait) {
  let timer = null;
  let lastArgs = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    return fn(...args);
  };
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  debounced.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return run();
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return debounced;
}

export const isTyping = (target) =>
  !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export const platform = () => document.body.dataset.platform || 'darwin';
export const isMac = () => platform() === 'darwin';
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');
export const revealLabel = () => (isMac() ? 'Show in Finder' : platform() === 'win32' ? 'Show in Explorer' : 'Show in folder');
