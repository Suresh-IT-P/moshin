/* In-memory copy of the database plus actions that persist changes through window.api. */

const api = window.api;

export const state = {
  info: null,
  customers: [],
  meetings: [],
  followups: [],
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of [...listeners]) fn();
}

export function replaceAll(snapshot) {
  state.customers = snapshot.customers;
  state.meetings = snapshot.meetings;
  state.followups = snapshot.followups;
  notify();
}

function upsert(key, item) {
  const list = state[key];
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
  notify();
  return item;
}

function drop(key, id) {
  state[key] = state[key].filter((x) => x.id !== id);
  notify();
}

/* -------------------------------------------------------------- selectors */

export const getCustomer = (id) => state.customers.find((c) => c.id === id) || null;
export const getMeeting = (id) => state.meetings.find((m) => m.id === id) || null;
export const getFollowup = (id) => state.followups.find((f) => f.id === id) || null;

export const sortedCustomers = () =>
  [...state.customers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

export const meetingsNewestFirst = () => [...state.meetings].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

export const meetingsForCustomer = (customerId) => meetingsNewestFirst().filter((m) => m.customerId === customerId);

export const followupsForMeeting = (meetingId) =>
  state.followups.filter((f) => f.meetingId === meetingId).sort(byDue);

export function byDue(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  return a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt);
}

/* ---------------------------------------------------------------- actions */

export async function reload() {
  replaceAll(await api.data.load());
}

export const createCustomer = async (input) => upsert('customers', await api.customers.create(input));
export const updateCustomer = async (id, patch) => upsert('customers', await api.customers.update(id, patch));
export const deleteCustomer = async (id) => replaceAll(await api.customers.remove(id));

export const putMeeting = (meeting) => upsert('meetings', meeting);
export const forgetMeeting = (id) => drop('meetings', id);

export async function updateMeeting(id, patch) {
  const meeting = upsert('meetings', await api.meetings.update(id, patch));
  // Changing the customer also moves the meeting's follow-ups to that customer.
  if ('customerId' in patch) await reload();
  return meeting;
}

export const deleteMeeting = async (id) => replaceAll(await api.meetings.remove(id));
export const importMeeting = async (input) => upsert('meetings', await api.meetings.importFile(input));

export const createFollowup = async (input) => upsert('followups', await api.followups.create(input));
export const updateFollowup = async (id, patch) => upsert('followups', await api.followups.update(id, patch));

export async function deleteFollowup(id) {
  await api.followups.remove(id);
  drop('followups', id);
}
