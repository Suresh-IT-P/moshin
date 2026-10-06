'use strict';

/**
 * Tiny JSON database for customers, meetings and follow-ups.
 * Every mutation is written to disk immediately (atomically via a temp file),
 * so nothing is lost if the app is closed unexpectedly.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COLLECTIONS = ['customers', 'meetings', 'followups'];
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const sameText = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanMarks(marks) {
  if (!Array.isArray(marks)) return [];
  return marks
    .slice(0, 2000)
    .map((mark) => ({
      id: typeof mark?.id === 'string' && mark.id ? mark.id.slice(0, 64) : newId(),
      t: Math.max(0, Math.round((Number(mark?.t) || 0) * 10) / 10),
      note: typeof mark?.note === 'string' ? mark.note.slice(0, 500) : '',
      createdAt: isoOrNull(mark?.createdAt) || now(),
    }))
    .sort((a, b) => a.t - b.t);
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = Store.empty();
  }

  static empty() {
    return { version: 1, customers: [], meetings: [], followups: [] };
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (raw !== null) {
      try {
        this.data = { ...Store.empty(), ...JSON.parse(raw) };
        // Keep one rolling backup of the last file that loaded successfully.
        fs.copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        // Corrupted file: keep a copy for inspection and fall back to the last good backup.
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        this.data = this.readBackup() || Store.empty();
      }
    }

    for (const key of COLLECTIONS) {
      if (!Array.isArray(this.data[key])) this.data[key] = [];
    }
    return this.data;
  }

  readBackup() {
    try {
      return { ...Store.empty(), ...JSON.parse(fs.readFileSync(`${this.file}.bak`, 'utf8')) };
    } catch {
      return null;
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows can refuse the rename while another process (e.g. antivirus) holds the file.
      fs.copyFileSync(tmp, this.file);
      fs.rmSync(tmp, { force: true });
    }
  }

  /* ---------------------------------------------------------------- customers */

  customer(id) {
    return this.data.customers.find((c) => c.id === id) || null;
  }

  cleanCustomer(input = {}) {
    return {
      name: text(input.name, 120),
      company: text(input.company, 120),
      phone: text(input.phone, 40),
      email: text(input.email, 160),
      notes: text(input.notes, 4000),
    };
  }

  assertUniqueCustomer(fields, exceptId = null) {
    const duplicate = this.data.customers.find(
      (c) => c.id !== exceptId && sameText(c.name, fields.name) && sameText(c.company, fields.company),
    );
    if (duplicate) {
      throw new Error(`"${fields.name}"${fields.company ? ` at ${fields.company}` : ''} already exists.`);
    }
  }

  createCustomer(input) {
    const fields = this.cleanCustomer(input);
    if (!fields.name) throw new Error('Customer name is required.');
    this.assertUniqueCustomer(fields);
    const customer = { id: newId(), ...fields, createdAt: now(), updatedAt: now() };
    this.data.customers.push(customer);
    this.save();
    return customer;
  }

  updateCustomer(id, patch) {
    const customer = this.customer(id);
    if (!customer) throw new Error('Customer not found.');
    const fields = this.cleanCustomer({ ...customer, ...patch });
    if (!fields.name) throw new Error('Customer name is required.');
    this.assertUniqueCustomer(fields, id);
    Object.assign(customer, fields, { updatedAt: now() });
    this.save();
    return customer;
  }

  /** Removes the customer with their meetings and follow-ups. Returns the removed meetings. */
  deleteCustomer(id) {
    const removed = this.data.meetings.filter((m) => m.customerId === id);
    this.data.customers = this.data.customers.filter((c) => c.id !== id);
    this.data.meetings = this.data.meetings.filter((m) => m.customerId !== id);
    this.data.followups = this.data.followups.filter((f) => f.customerId !== id);
    this.save();
    return removed;
  }

  /* ----------------------------------------------------------------- meetings */

  meeting(id) {
    return this.data.meetings.find((m) => m.id === id) || null;
  }

  mustMeeting(id) {
    const meeting = this.meeting(id);
    if (!meeting) throw new Error('Meeting not found.');
    return meeting;
  }

  createMeeting(fields) {
    const meeting = {
      id: newId(),
      customerId: fields.customerId,
      title: text(fields.title, 200) || 'Meeting',
      source: fields.source === 'uploaded' ? 'uploaded' : 'recorded',
      fileName: fields.fileName,
      originalName: text(fields.originalName, 260),
      mimeType: text(fields.mimeType, 100),
      startedAt: isoOrNull(fields.startedAt) || now(),
      durationSec: Math.max(0, Math.round(Number(fields.durationSec) || 0)),
      sizeBytes: Math.max(0, Number(fields.sizeBytes) || 0),
      status: fields.status === 'recording' ? 'recording' : 'ready',
      recovered: false,
      notes: typeof fields.notes === 'string' ? fields.notes.slice(0, 200000) : '',
      marks: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.data.meetings.push(meeting);
    this.save();
    return meeting;
  }

  /** Fields the user can edit from the app. */
  updateMeeting(id, patch = {}) {
    const meeting = this.mustMeeting(id);
    if ('title' in patch) meeting.title = text(patch.title, 200) || meeting.title;
    if ('notes' in patch && typeof patch.notes === 'string') meeting.notes = patch.notes.slice(0, 200000);
    if ('marks' in patch) meeting.marks = cleanMarks(patch.marks);
    if ('startedAt' in patch) meeting.startedAt = isoOrNull(patch.startedAt) || meeting.startedAt;
    if ('durationSec' in patch) meeting.durationSec = Math.max(0, Math.round(Number(patch.durationSec) || 0));
    if ('customerId' in patch && patch.customerId !== meeting.customerId) {
      if (!this.customer(patch.customerId)) throw new Error('Customer not found.');
      meeting.customerId = patch.customerId;
      for (const followup of this.data.followups) {
        if (followup.meetingId === id) followup.customerId = patch.customerId;
      }
    }
    meeting.updatedAt = now();
    this.save();
    return meeting;
  }

  /** Internal bookkeeping fields (status, size, ...). */
  setMeetingFields(id, fields) {
    const meeting = this.mustMeeting(id);
    Object.assign(meeting, fields, { updatedAt: now() });
    this.save();
    return meeting;
  }

  deleteMeeting(id, { keepFollowups = false } = {}) {
    const meeting = this.meeting(id);
    this.data.meetings = this.data.meetings.filter((m) => m.id !== id);
    if (keepFollowups) {
      for (const followup of this.data.followups) {
        if (followup.meetingId === id) followup.meetingId = null;
      }
    } else {
      this.data.followups = this.data.followups.filter((f) => f.meetingId !== id);
    }
    this.save();
    return meeting;
  }

  /* ---------------------------------------------------------------- followups */

  followup(id) {
    return this.data.followups.find((f) => f.id === id) || null;
  }

  createFollowup(input = {}) {
    const title = text(input.title, 300);
    if (!title) throw new Error('Please describe the follow-up.');
    if (!isDateKey(input.dueDate)) throw new Error('Please pick a due date.');
    const meeting = input.meetingId ? this.meeting(input.meetingId) : null;
    const customerId = meeting ? meeting.customerId : this.customer(input.customerId)?.id || null;
    const followup = {
      id: newId(),
      title,
      dueDate: input.dueDate,
      customerId,
      meetingId: meeting ? meeting.id : null,
      done: false,
      doneAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.data.followups.push(followup);
    this.save();
    return followup;
  }

  updateFollowup(id, patch = {}) {
    const followup = this.followup(id);
    if (!followup) throw new Error('Follow-up not found.');
    if ('title' in patch) {
      const title = text(patch.title, 300);
      if (!title) throw new Error('Please describe the follow-up.');
      followup.title = title;
    }
    if ('dueDate' in patch) {
      if (!isDateKey(patch.dueDate)) throw new Error('Please pick a due date.');
      followup.dueDate = patch.dueDate;
    }
    if ('done' in patch) {
      followup.done = Boolean(patch.done);
      followup.doneAt = followup.done ? now() : null;
    }
    if ('meetingId' in patch) {
      const meeting = patch.meetingId ? this.meeting(patch.meetingId) : null;
      followup.meetingId = meeting ? meeting.id : null;
      if (meeting) followup.customerId = meeting.customerId;
    }
    if ('customerId' in patch && !followup.meetingId) {
      followup.customerId = this.customer(patch.customerId)?.id || null;
    }
    followup.updatedAt = now();
    this.save();
    return followup;
  }

  deleteFollowup(id) {
    this.data.followups = this.data.followups.filter((f) => f.id !== id);
    this.save();
  }
}

module.exports = { Store, isDateKey };
