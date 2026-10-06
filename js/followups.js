/* Follow-ups: list items, quick actions and the add/edit form. */

import { el, esc, avatar, dueLabel, dueTone, todayKey, addDays, endOfWeek, endOfMonth, fmtDay } from './utils.js';
import { icon } from './icons.js';
import {
  state,
  getCustomer,
  getMeeting,
  getFollowup,
  meetingsForCustomer,
  createFollowup,
  updateFollowup,
  deleteFollowup,
  byDue,
} from './store.js';
import { openModal, toast, toastError, confirmDialog, dueField, withBusy } from './ui.js';
import { pickCustomer } from './customers.js';

/** Pending follow-ups grouped into the dashboard windows. */
export function followupBuckets() {
  const today = todayKey();
  const weekEnd = endOfWeek(today);
  const tenDays = addDays(today, 10);
  const monthEnd = endOfMonth(today);
  const pending = state.followups.filter((f) => !f.done).sort(byDue);
  const upcoming = (end) => pending.filter((f) => f.dueDate >= today && f.dueDate <= end);
  return {
    today: pending.filter((f) => f.dueDate === today),
    week: upcoming(weekEnd),
    ten: upcoming(tenDays),
    month: upcoming(monthEnd),
    overdue: pending.filter((f) => f.dueDate < today),
    pending,
  };
}

export function followupItem(f, { showCustomer = true, showMeeting = true } = {}) {
  const customer = showCustomer ? getCustomer(f.customerId) : null;
  const meeting = showMeeting && f.meetingId ? getMeeting(f.meetingId) : null;
  const tone = f.done ? 'done' : dueTone(f.dueDate);
  return `
    <div class="fu-item ${f.done ? 'is-done' : ''}" data-id="${f.id}">
      <button type="button" class="fu-check" data-action="toggle-followup" data-id="${f.id}"
              aria-label="${f.done ? 'Mark as not done' : 'Mark as done'}" title="${f.done ? 'Mark as not done' : 'Mark as done'}">
        ${icon('check', 13)}
      </button>
      <div class="fu-main">
        <div class="fu-title">${esc(f.title)}</div>
        ${customer || meeting ? `
          <div class="fu-meta">
            ${customer ? `<span class="fu-customer">${avatar(customer, 'xs')}${esc(customer.name)}</span>` : ''}
            ${meeting ? `<button type="button" class="fu-meeting" data-action="open-meeting" data-id="${meeting.id}" title="Open meeting">${icon('mic', 12)}<span>${esc(meeting.title)}</span><em>${esc(fmtDay(meeting.startedAt))}</em></button>` : ''}
          </div>` : ''}
      </div>
      <span class="due-badge due-${tone}">${icon(f.done ? 'check-circle' : 'calendar', 13)}${esc(f.done ? 'Done' : dueLabel(f.dueDate))}</span>
      <div class="fu-actions">
        <button type="button" class="icon-btn sm" data-action="edit-followup" data-id="${f.id}" title="Edit">${icon('pencil', 15)}</button>
        <button type="button" class="icon-btn sm danger" data-action="delete-followup" data-id="${f.id}" title="Delete">${icon('trash', 15)}</button>
      </div>
    </div>`;
}

export async function toggleFollowup(id, trigger) {
  const followup = getFollowup(id);
  if (!followup) return;
  const done = !followup.done;
  const row = trigger?.closest('.fu-item');
  if (done && row) {
    row.classList.add('is-completing');
    await new Promise((resolve) => setTimeout(resolve, 380));
  }
  try {
    await updateFollowup(id, { done });
  } catch (err) {
    row?.classList.remove('is-completing');
    toastError(err);
    return;
  }
  if (done) {
    toast('Follow-up done — nice work!', {
      action: { label: 'Undo', onClick: () => updateFollowup(id, { done: false }).catch(toastError) },
    });
  }
}

export async function removeFollowup(id) {
  const followup = getFollowup(id);
  if (!followup) return;
  const ok = await confirmDialog({
    title: 'Delete this follow-up?',
    message: `“${followup.title}” will be removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteFollowup(id);
    toast('Follow-up deleted');
  } catch (err) {
    toastError(err);
  }
}

/** Add or edit a follow-up. Resolves with the saved follow-up or null. */
export function openFollowupForm({ followup = null, customerId = null, meetingId = null } = {}) {
  return new Promise((resolve) => {
    const isEdit = Boolean(followup);
    const lockedMeeting = !isEdit && meetingId ? getMeeting(meetingId) : null;
    let saved = null;

    const form = el(`
      <form class="form" novalidate autocomplete="off">
        <div class="field">
          <label for="fu-title">What needs to happen?</label>
          <input id="fu-title" class="input" name="title" maxlength="300" placeholder="e.g. Send the revised quotation" value="${esc(followup?.title || '')}" autofocus />
        </div>
        <div class="field" data-customer-field>
          <label>Customer</label>
          <div data-slot="customer"></div>
        </div>
        <div class="field">
          <label>Due date</label>
          <div data-slot="due"></div>
        </div>
        <div class="field" data-meeting-field>
          <label for="fu-meeting">Related meeting <span class="optional">optional</span></label>
          <div class="select-wrap">
            <select id="fu-meeting" class="input" name="meetingId"></select>
            ${icon('chevron-down', 16)}
          </div>
        </div>
        <p class="form-error" hidden></p>
      </form>`);

    const initialCustomer =
      followup?.customerId || customerId || (meetingId ? getMeeting(meetingId)?.customerId : null) || null;
    const picker = pickCustomer({ value: initialCustomer, onChange: () => fillMeetings(null) });
    form.querySelector('[data-slot="customer"]').append(picker.el);
    const due = dueField({ value: followup?.dueDate || addDays(todayKey(), 1) });
    form.querySelector('[data-slot="due"]').append(due.el);
    const meetingSelect = form.querySelector('select');

    function fillMeetings(selected) {
      const meetings = picker.value ? meetingsForCustomer(picker.value) : [];
      meetingSelect.innerHTML = `
        <option value="">No specific meeting</option>
        ${meetings.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.title)} — ${esc(fmtDay(m.startedAt))}</option>`).join('')}`;
      meetingSelect.disabled = !meetings.length;
    }
    fillMeetings(followup?.meetingId || meetingId);

    if (lockedMeeting) {
      // Adding from inside a meeting: customer and meeting are already known.
      form.querySelector('[data-customer-field]').hidden = true;
      form.querySelector('[data-meeting-field]').hidden = true;
    }

    const modal = openModal({
      title: isEdit ? 'Edit follow-up' : 'New follow-up',
      subtitle: lockedMeeting ? `From “${lockedMeeting.title}”` : 'A promise made in a meeting? Put a date on it.',
      body: form,
      footer: `
        <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>${icon('check', 16)} ${isEdit ? 'Save changes' : 'Add follow-up'}</button>`,
      onClose: () => resolve(saved),
    });
    modal.onCleanup(picker.destroy);

    const errorEl = form.querySelector('.form-error');
    const saveButton = modal.footer.querySelector('[data-save]');

    async function submit() {
      const title = form.querySelector('[name="title"]').value.trim();
      const showError = (message) => {
        errorEl.textContent = message;
        errorEl.hidden = false;
      };
      if (!title) return showError('Please describe the follow-up.');
      if (!due.value) return showError('Please pick a due date.');
      if (!picker.value && !lockedMeeting) return showError('Please choose the customer this follow-up is for.');
      const input = {
        title,
        dueDate: due.value,
        customerId: lockedMeeting ? lockedMeeting.customerId : picker.value,
        meetingId: lockedMeeting ? lockedMeeting.id : meetingSelect.value || null,
      };
      try {
        saved = await withBusy(saveButton, 'Saving…', () =>
          isEdit ? updateFollowup(followup.id, input) : createFollowup(input),
        );
        toast(isEdit ? 'Follow-up updated' : 'Follow-up added');
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
    form.querySelector('[name="title"]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  });
}
