/* Reusable UI building blocks: modals & drawers, toasts, confirm dialogs, menus, pickers. */

import { el, esc, avatar, todayKey, addDays, nextMonday } from './utils.js';
import { icon } from './icons.js';
import { getCustomer, sortedCustomers } from './store.js';

/* ------------------------------------------------------------ modals/drawers */

const stack = [];
export const topLayer = () => stack[stack.length - 1] || null;

function fill(container, content) {
  if (typeof content === 'string') container.innerHTML = content;
  else if (content) container.append(content);
}

/**
 * Opens a modal (or a right-hand drawer with variant: 'drawer'). Modals stack, so a
 * "New customer" form can open on top of the "Record meeting" form and return to it.
 */
export function openModal({
  title = '',
  subtitle = '',
  body = '',
  footer = '',
  size = 'md',
  variant = 'modal',
  dismissible = true,
  className = '',
  onClose,
} = {}) {
  const panelClass = variant === 'drawer' ? 'drawer' : `modal modal-${size}`;
  const layer = el(`
    <div class="layer layer-${variant} ${className}">
      <div class="${panelClass}" role="dialog" aria-modal="true" tabindex="-1" ${title ? `aria-label="${esc(title)}"` : ''}>
        ${title ? `
          <header class="modal-header">
            <div class="modal-heading">
              <h2>${esc(title)}</h2>
              ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
            </div>
            ${dismissible ? `<button type="button" class="icon-btn" data-modal-close aria-label="Close">${icon('x', 18)}</button>` : ''}
          </header>` : ''}
        <div class="modal-body"></div>
        ${footer ? '<footer class="modal-footer"></footer>' : ''}
      </div>
    </div>`);
  const panel = layer.firstElementChild;
  const bodyEl = panel.querySelector('.modal-body');
  const footerEl = panel.querySelector('.modal-footer');
  fill(bodyEl, body);
  if (footerEl) fill(footerEl, footer);

  const entry = { layer, panel, dismissible, cleanups: [], closed: false };
  const returnFocus = document.activeElement;

  function close(result) {
    if (entry.closed) return;
    entry.closed = true;
    for (const fn of entry.cleanups) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
    stack.splice(stack.indexOf(entry), 1);
    layer.classList.remove('is-open');
    layer.classList.add('is-closing');
    setTimeout(() => layer.remove(), 240);
    if (!stack.length) document.body.classList.remove('has-layer');
    onClose?.(result);
    if (returnFocus && returnFocus !== document.body && document.contains(returnFocus)) {
      returnFocus.focus?.({ preventScroll: true });
    }
  }
  entry.close = close;

  // Close on a click that both starts and ends on the backdrop (not when selecting text).
  let pressedBackdrop = false;
  layer.addEventListener('mousedown', (e) => {
    pressedBackdrop = e.target === layer;
  });
  layer.addEventListener('click', (e) => {
    if (e.target === layer && pressedBackdrop && entry.dismissible) close();
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]')) close();
  });

  layer.style.zIndex = String(1000 + stack.length * 10);
  stack.push(entry);
  document.getElementById('layer-root').append(layer);
  document.body.classList.add('has-layer');
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('is-open')));
  setTimeout(() => {
    if (entry.closed) return;
    const target =
      panel.querySelector('[autofocus]') ||
      panel.querySelector('input:not([type=hidden]):not([readonly]):not([type=date]), textarea');
    (target || panel).focus({ preventScroll: true });
  }, 60);

  return {
    el: panel,
    body: bodyEl,
    footer: footerEl,
    close,
    onCleanup: (fn) => entry.cleanups.push(fn),
    isTop: () => topLayer() === entry,
    get closed() {
      return entry.closed;
    },
  };
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = topLayer();
  if (top?.dismissible) {
    e.preventDefault();
    top.close();
  }
});

/* -------------------------------------------------------------------- toasts */

export function toast(message, { type = 'success', action = null, duration = 4000 } = {}) {
  const root = document.getElementById('toast-root');
  const iconName = { success: 'check-circle', error: 'alert', warning: 'alert', info: 'info' }[type] || 'info';
  const node = el(`
    <div class="toast toast-${type}" role="${type === 'error' ? 'alert' : 'status'}">
      <span class="toast-icon">${icon(iconName, 18)}</span>
      <span class="toast-msg">${esc(message)}</span>
      ${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}
      <button type="button" class="toast-close" aria-label="Dismiss">${icon('x', 14)}</button>
    </div>`);
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  };
  node.querySelector('.toast-close').addEventListener('click', dismiss);
  node.querySelector('.toast-action')?.addEventListener('click', () => {
    dismiss();
    action.onClick();
  });
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    timer = setTimeout(dismiss, 1800);
  });
  root.append(node);
  while (root.children.length > 4) root.firstElementChild.remove();
  timer = setTimeout(dismiss, type === 'error' ? Math.max(duration, 7000) : duration);
  return dismiss;
}

export const toastError = (err) => toast(err?.message || String(err), { type: 'error' });

/* ------------------------------------------------------------------- confirm */

export function confirmDialog({
  title,
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  iconName = null,
} = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const modal = openModal({
      size: 'sm',
      body: `
        <div class="confirm">
          <div class="confirm-icon ${danger ? 'is-danger' : ''}">${icon(iconName || (danger ? 'trash' : 'info'), 22)}</div>
          <h3>${esc(title)}</h3>
          ${message ? `<p>${esc(message)}</p>` : ''}
        </div>`,
      footer: `
        <button type="button" class="btn btn-ghost" data-modal-close>${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
      onClose: () => resolve(confirmed),
    });
    const button = modal.footer.querySelector('[data-confirm]');
    button.addEventListener('click', () => {
      confirmed = true;
      modal.close();
    });
    setTimeout(() => button.focus(), 90);
  });
}

/* ------------------------------------------------------------- popover menus */

let popover = null;

export function closeMenu() {
  if (!popover) return;
  popover.cleanup();
  popover.menu.remove();
  popover = null;
}

/** items: [{ label, icon, danger, onClick }] or '-' for a separator */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = el(`
    <div class="popover" role="menu">
      ${items
        .map((item, i) =>
          item === '-'
            ? '<div class="popover-sep"></div>'
            : `<button type="button" class="popover-item ${item.danger ? 'is-danger' : ''}" data-index="${i}" role="menuitem">
                 ${icon(item.icon, 16)}<span>${esc(item.label)}</span>
               </button>`,
        )
        .join('')}
    </div>`);
  document.body.append(menu);

  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let top = a.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = a.top - m.height - 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, a.right - m.width)}px`;

  const onDown = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  };
  menu.addEventListener('click', (e) => {
    const button = e.target.closest('[data-index]');
    if (!button) return;
    const item = items[Number(button.dataset.index)];
    closeMenu();
    item.onClick?.();
  });
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  popover = {
    menu,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
    },
  };
  requestAnimationFrame(() => menu.classList.add('is-open'));
}

/* ----------------------------------------------------------- customer picker */

/**
 * Searchable customer dropdown. The last option is always "Add new customer",
 * which calls onCreate(typedName) and selects the customer it resolves with.
 */
export function customerPicker({ value = null, placeholder = 'Search or add a customer…', onChange, onCreate } = {}) {
  let selectedId = value;
  let isOpen = false;
  let active = 0;
  let options = [];

  const root = el(`
    <div class="combo">
      <span class="combo-lead"></span>
      <input type="text" class="input combo-input" autocomplete="off" spellcheck="false"
             role="combobox" aria-expanded="false" aria-autocomplete="list" />
      <span class="combo-caret">${icon('chevron-down', 16)}</span>
    </div>`);
  const input = root.querySelector('input');
  const lead = root.querySelector('.combo-lead');
  const menu = el('<div class="combo-menu" role="listbox"></div>');

  function sync() {
    const customer = getCustomer(selectedId);
    input.value = customer ? customer.name : '';
    input.placeholder = placeholder;
    lead.innerHTML = customer ? avatar(customer, 'xs') : icon('search', 16);
    root.classList.toggle('has-value', !!customer);
  }

  function matches(query) {
    const q = query.trim().toLowerCase();
    const list = sortedCustomers();
    if (!q) return list;
    return list.filter((c) => [c.name, c.company, c.email, c.phone].some((v) => (v || '').toLowerCase().includes(q)));
  }

  function render() {
    const q = input.value.trim();
    const list = matches(q);
    const exact = list.some((c) => c.name.toLowerCase() === q.toLowerCase());
    options = list.map((customer) => ({ type: 'customer', customer }));
    options.push({ type: 'new', name: exact ? '' : q });
    active = Math.min(Math.max(active, 0), options.length - 1);
    menu.innerHTML = `
      ${list.length ? '' : `<div class="combo-empty">${q ? `No customer matches “${esc(q)}”` : 'No customers yet — add your first one'}</div>`}
      ${options
        .map((o, i) =>
          o.type === 'customer'
            ? `<div class="combo-option ${i === active ? 'is-active' : ''} ${o.customer.id === selectedId ? 'is-selected' : ''}" data-index="${i}" role="option">
                 ${avatar(o.customer, 'sm')}
                 <span class="combo-text"><strong>${esc(o.customer.name)}</strong>${o.customer.company ? `<small>${esc(o.customer.company)}</small>` : ''}</span>
                 ${o.customer.id === selectedId ? icon('check', 16, 'combo-check') : ''}
               </div>`
            : `<div class="combo-option combo-new ${i === active ? 'is-active' : ''}" data-index="${i}" role="option">
                 <span class="combo-new-icon">${icon('user-plus', 16)}</span>
                 <span class="combo-text"><strong>${o.name ? `Add “${esc(o.name)}” as a new customer` : 'Add a new customer'}</strong><small>Opens a quick form, then selects them</small></span>
               </div>`,
        )
        .join('')}`;
    menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function place() {
    if (!document.contains(root)) return close();
    const r = root.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    if (below < 240 && above > below) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
      menu.style.maxHeight = `${Math.min(320, above - 24)}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.maxHeight = `${Math.min(320, below - 24)}px`;
    }
  }

  function open(clearText = true) {
    if (isOpen) return;
    isOpen = true;
    if (clearText) {
      const current = getCustomer(selectedId);
      input.value = '';
      input.placeholder = current ? current.name : placeholder;
    }
    active = Math.max(0, sortedCustomers().findIndex((c) => c.id === selectedId));
    render();
    document.body.append(menu);
    place();
    setTimeout(() => isOpen && place(), 260); // the surrounding modal may still be animating in
    root.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    menu.remove();
    root.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', place);
    document.removeEventListener('scroll', place, true);
    sync();
  }

  function select(id) {
    selectedId = id;
    sync();
    onChange?.(id);
  }

  async function choose(index) {
    const option = options[index];
    if (!option) return;
    close();
    input.blur();
    if (option.type === 'customer') {
      select(option.customer.id);
      return;
    }
    const created = await onCreate?.(option.name);
    if (created) select(created.id);
  }

  input.addEventListener('focus', () => open());
  input.addEventListener('mousedown', () => {
    if (document.activeElement === input && !isOpen) open();
  });
  input.addEventListener('blur', () => close());
  input.addEventListener('input', () => {
    active = 0;
    if (!isOpen) open(false);
    else render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) return open();
      active += e.key === 'ArrowDown' ? 1 : -1;
      render();
    } else if (e.key === 'Enter') {
      if (isOpen) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault(); // keep the surrounding modal open
      close();
    }
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  menu.addEventListener('click', (e) => {
    const option = e.target.closest('[data-index]');
    if (option) choose(Number(option.dataset.index));
  });
  root.querySelector('.combo-caret').addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (isOpen) input.blur();
    else input.focus();
  });

  sync();
  return {
    el: root,
    get value() {
      return selectedId;
    },
    set value(id) {
      select(id);
    },
    focus: () => input.focus(),
    refresh: sync,
    destroy: close,
  };
}

/* ------------------------------------------------------------ due date field */

export function dueField({ value = addDays(todayKey(), 1), compact = false } = {}) {
  const chips = compact
    ? [['Tomorrow', 1], ['In 3 days', 3], ['Next week', 'monday']]
    : [['Today', 0], ['Tomorrow', 1], ['In 3 days', 3], ['Next Monday', 'monday'], ['In 10 days', 10]];
  const wrap = el(`
    <div class="due-field ${compact ? 'is-compact' : ''}">
      <input type="date" class="input" name="dueDate" value="${esc(value)}" required />
      <div class="chip-row">
        ${chips.map(([label, days]) => `<button type="button" class="chip" data-days="${days}">${label}</button>`).join('')}
      </div>
    </div>`);
  const input = wrap.querySelector('input');
  const dateFor = (days) => (days === 'monday' ? nextMonday(todayKey()) : addDays(todayKey(), Number(days)));
  const highlight = () => {
    for (const chip of wrap.querySelectorAll('.chip')) {
      chip.classList.toggle('is-active', dateFor(chip.dataset.days) === input.value);
    }
  };
  wrap.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    input.value = dateFor(chip.dataset.days);
    highlight();
  });
  input.addEventListener('input', highlight);
  highlight();
  return {
    el: wrap,
    input,
    get value() {
      return input.value;
    },
    set value(v) {
      input.value = v;
      highlight();
    },
  };
}

/** Disable a button and show a spinner while an async task runs. */
export async function withBusy(button, label, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.innerHTML = `<span class="spinner"></span>${esc(label)}`;
  try {
    return await task();
  } finally {
    if (document.contains(button)) {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.innerHTML = original;
    }
  }
}
