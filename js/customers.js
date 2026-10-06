/* Add / edit customers and the customer list. */

import { el, esc, avatar, plural, fmtDay } from './utils.js';
import { icon } from './icons.js';
import {
  state,
  subscribe,
  sortedCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  meetingsForCustomer,
} from './store.js';
import { openModal, toast, toastError, confirmDialog, customerPicker, withBusy } from './ui.js';

/**
 * Opens the customer form. Resolves with the saved customer, or null if cancelled.
 * `prefill.name` is used when the user typed a new name into a customer dropdown.
 */
export function openCustomerForm({ customer = null, prefill = {} } = {}) {
  return new Promise((resolve) => {
    const isEdit = Boolean(customer);
    const data = customer || prefill;
    let saved = null;

    const form = el(`
      <form class="form form-grid" novalidate autocomplete="off">
        <div class="field span-2">
          <label for="cf-name">Customer name <span class="req">*</span></label>
          <div class="input-with-icon">
            ${icon('users', 16)}
            <input id="cf-name" class="input" name="name" maxlength="120" placeholder="e.g. Priya Sharma" value="${esc(data.name || '')}" autofocus />
          </div>
        </div>
        <div class="field span-2">
          <label for="cf-company">Company <span class="optional">optional</span></label>
          <div class="input-with-icon">
            ${icon('building', 16)}
            <input id="cf-company" class="input" name="company" maxlength="120" placeholder="e.g. Acme Industries" value="${esc(data.company || '')}" />
          </div>
        </div>
        <div class="field">
          <label for="cf-phone">Phone</label>
          <div class="input-with-icon">
            ${icon('phone', 16)}
            <input id="cf-phone" class="input" name="phone" type="tel" maxlength="40" placeholder="+91 98765 43210" value="${esc(data.phone || '')}" />
          </div>
        </div>
        <div class="field">
          <label for="cf-email">Email</label>
          <div class="input-with-icon">
            ${icon('mail', 16)}
            <input id="cf-email" class="input" name="email" type="email" maxlength="160" placeholder="name@company.com" value="${esc(data.email || '')}" />
          </div>
        </div>
        <div class="field span-2">
          <label for="cf-notes">Notes <span class="optional">optional</span></label>
          <textarea id="cf-notes" class="input" name="notes" rows="3" maxlength="4000" placeholder="Anything worth remembering about this customer">${esc(data.notes || '')}</textarea>
        </div>
        <p class="form-error span-2" hidden></p>
      </form>`);

    const modal = openModal({
      title: isEdit ? 'Edit customer' : 'Add customer',
      subtitle: isEdit ? 'Update their contact details.' : 'Save a customer once, then pick them for every meeting.',
      body: form,
      footer: `
        <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>${icon('check', 16)} ${isEdit ? 'Save changes' : 'Add customer'}</button>`,
      onClose: () => resolve(saved),
    });

    const errorEl = form.querySelector('.form-error');
    const saveButton = modal.footer.querySelector('[data-save]');
    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
    };

    async function submit() {
      const values = Object.fromEntries(new FormData(form));
      if (!values.name.trim()) {
        showError('Please enter the customer’s name.');
        form.querySelector('[name="name"]').focus();
        return;
      }
      if (values.email.trim() && !/^\S+@\S+\.\S+$/.test(values.email.trim())) {
        showError('That email address looks incomplete.');
        form.querySelector('[name="email"]').focus();
        return;
      }
      errorEl.hidden = true;
      try {
        saved = await withBusy(saveButton, 'Saving…', () =>
          isEdit ? updateCustomer(customer.id, values) : createCustomer(values),
        );
        toast(isEdit ? 'Customer updated' : `${saved.name} added to your customers`);
        modal.close();
      } catch (err) {
        showError(err.message);
      }
    }

    saveButton.addEventListener('click', submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        submit();
      }
    });
  });
}

/** Customer dropdown whose "Add new customer" option opens the customer form. */
export function pickCustomer(options = {}) {
  return customerPicker({ ...options, onCreate: (name) => openCustomerForm({ prefill: { name } }) });
}

export async function removeCustomer(customer) {
  const meetings = meetingsForCustomer(customer.id).length;
  const ok = await confirmDialog({
    title: `Delete ${customer.name}?`,
    message: meetings
      ? `This also deletes their ${plural(meetings, 'meeting')} and follow-ups. Recordings are moved to the Trash, so you can still recover the audio.`
      : 'This customer has no meetings yet.',
    confirmLabel: 'Delete customer',
    danger: true,
  });
  if (!ok) return false;
  try {
    await deleteCustomer(customer.id);
    toast(`${customer.name} deleted`);
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

/** The customer directory (opened from the dashboard). */
export function openCustomersList({ onViewMeetings } = {}) {
  let query = '';
  const body = el(`
    <div class="customers">
      <div class="search-box">
        ${icon('search', 16)}
        <input class="input" type="search" placeholder="Search by name, company, phone or email…" autofocus />
      </div>
      <div class="customer-list"></div>
    </div>`);
  const list = body.querySelector('.customer-list');

  const modal = openModal({
    title: 'Customers',
    subtitle: 'Everyone you meet with, in one place.',
    size: 'lg',
    body,
    footer: `
      <button type="button" class="btn btn-ghost" data-modal-close>Close</button>
      <button type="button" class="btn btn-primary" data-add>${icon('user-plus', 16)} Add customer</button>`,
  });

  function render() {
    const q = query.trim().toLowerCase();
    const customers = sortedCustomers().filter(
      (c) => !q || [c.name, c.company, c.phone, c.email].some((v) => (v || '').toLowerCase().includes(q)),
    );
    if (!state.customers.length) {
      list.innerHTML = `
        <div class="empty empty-sm">
          <div class="empty-art">${icon('users', 30)}</div>
          <h3>No customers yet</h3>
          <p>Add the people you meet so every recording is filed under the right name.</p>
        </div>`;
      return;
    }
    if (!customers.length) {
      list.innerHTML = `<div class="empty empty-sm"><p>No customer matches “${esc(query)}”.</p></div>`;
      return;
    }
    list.innerHTML = customers
      .map((c) => {
        const meetings = meetingsForCustomer(c.id);
        const contact = [c.phone, c.email].filter(Boolean).map(esc).join(' · ');
        return `
          <div class="customer-row" data-id="${c.id}">
            ${avatar(c, 'md')}
            <div class="customer-main">
              <strong>${esc(c.name)}</strong>
              <span>${c.company ? esc(c.company) : '<em>No company</em>'}${contact ? ` · ${contact}` : ''}</span>
            </div>
            <div class="customer-meta">
              <span class="pill">${icon('mic', 13)} ${plural(meetings.length, 'meeting')}</span>
              ${meetings[0] ? `<span class="customer-last">Last: ${esc(fmtDay(meetings[0].startedAt))}</span>` : ''}
            </div>
            <div class="row-actions">
              <button type="button" class="icon-btn sm" data-act="meetings" title="View meetings">${icon('arrow-right', 16)}</button>
              <button type="button" class="icon-btn sm" data-act="edit" title="Edit">${icon('pencil', 15)}</button>
              <button type="button" class="icon-btn sm danger" data-act="delete" title="Delete">${icon('trash', 15)}</button>
            </div>
          </div>`;
      })
      .join('');
  }

  body.querySelector('input').addEventListener('input', (e) => {
    query = e.target.value;
    render();
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.customer-row');
    if (!row) return;
    const customer = state.customers.find((c) => c.id === row.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act || 'meetings';
    if (act === 'edit') openCustomerForm({ customer });
    else if (act === 'delete') removeCustomer(customer);
    else {
      modal.close();
      onViewMeetings?.(customer.id);
    }
  });
  modal.footer.querySelector('[data-add]').addEventListener('click', () => openCustomerForm());
  modal.onCleanup(subscribe(render));
  render();
}
