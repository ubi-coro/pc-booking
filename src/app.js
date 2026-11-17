import { config } from './config.js';
import * as auth from './auth.js';
import { githubStore, AuthError } from './store-github.js';
import { localStore } from './store-local.js';
import { DAY, toDay, toIso, today, weekday, mondayOf, dayOfMonth, overlaps, fmtMonth, fmtMonthSpan, fmtRange, WEEKDAYS } from './dates.js';

const W = 44;          // px per day column
const LANE = 30;       // px per stacked booking lane
const MIN_DAYS = 7 * 16; // smallest rendered window; it re-centres as you scroll, so the timeline feels endless
const MARGIN = 14;       // extra days beyond a full screen on each side of the window

// Critically damped feel (no overshoot) and its mirror for exits.
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_IN = 'cubic-bezier(0.64, 0, 0.78, 0)';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = s => document.querySelector(s);
const board = $('#board');
const editor = $('#editor');
const form = $('#editor-form');

const demo = !config.githubAppClientId || new URLSearchParams(location.search).has('demo');

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('pcb.prefs')) ?? {}; } catch { return {}; }
})();
function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { localStorage.setItem('pcb.prefs', JSON.stringify(prefs)); } catch {}
}

const shortGpu = gpu => gpu.replace(/^NVIDIA\s+/, '').replace(/^GeForce\s+/, '');
const place = pc => [pc.room, pc.location].filter(Boolean).join(' ');

// Sortable PC columns. Numeric ones sort descending first (biggest GPU on top); GPU sorts by VRAM.
const COLUMNS = [
  { key: 'id', label: 'PC', value: p => p.id },
  { key: 'gpu', label: 'GPU', value: p => p.vram, numeric: true },
  { key: 'ram', label: 'RAM', value: p => p.ram, numeric: true, right: true },
  { key: 'location', label: 'Location', value: p => `${p.location} ${p.setup || ''}` },
  { key: 'netboot', label: 'Netboot', value: p => (p.netboot ? 1 : 0), numeric: true },
  { key: 'responsible', label: 'Responsible', value: p => p.responsible || '' },
];

const state = {
  pcs: [],
  bookings: [],
  me: null,
  start: mondayOf(today()) - 14,
  days: MIN_DAYS,
  q: '',
  free: null,         // { from, to, applied } day numbers, selected in the day header; rows filter once applied
  draft: null,        // new booking shown as a ghost while the editor is open
  appear: null,       // id of a just-created booking, rendered with an entrance
  settlingId: null,   // id whose bar is hidden while the dropped copy glides into place
  sort: COLUMNS.some(c => c.key === prefs.sort?.key) ? prefs.sort : { key: 'id', dir: 1 },
  syncedAt: null,
};

let store = null;
let drag = null;
let settling = null;
let suppressClick = false;
let editing = null;
let lastPointer = null;
let pending = 0;
let queue = Promise.resolve();

// ---------- helpers

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const bookingsFor = (pc, list = state.bookings) => list.filter(b => b.pc === pc);
const byId = id => state.bookings.find(b => b.id === id);
const barEl = id => board.querySelector(`.bar[data-id="${CSS.escape(id)}"]`);
function hue(s) {
  let x = 0;
  for (const c of s.trim().toLowerCase()) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}
const label = b => `${b.user}${b.note ? ` · ${b.note}` : ''}`;
const describe = b => `${label(b)}\n${b.pc}, ${fmtRange(toDay(b.from), toDay(b.to))}${b.preemptible ? '\nPreemptible' : ''}`;
const conflicts = (pc, from, to, id) => bookingsFor(pc).filter(b => b.id !== id && overlaps(b, from, to));

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(h('span', null, msg));
  if (action) {
    const btn = h('button', null, action.label);
    btn.onclick = () => { t.hidden = true; action.run(); };
    t.append(btn);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 5000);
}

function setSync(text) { $('#sync').textContent = text; }
function syncedLabel() {
  const time = state.syncedAt?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setSync(demo ? 'Saved in this browser' : time ? `Synced ${time}` : '');
}

// ---------- filtering & sorting

function visiblePcs() {
  const needle = state.q.trim().toLowerCase();
  const free = state.free?.applied ? state.free : null;
  const col = COLUMNS.find(c => c.key === state.sort.key) ?? COLUMNS[0];
  const { dir } = state.sort;
  return state.pcs
    .filter(pc => {
      if (needle) {
        const hay = [pc.id, pc.gpu, pc.location, pc.room, pc.setup, pc.responsible, pc.notes, `${pc.vram} gb`, ...bookingsFor(pc.id).map(b => b.user)]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return !free || !bookingsFor(pc.id).some(b => !b.preemptible && overlaps(b, free.from, free.to));
    })
    .sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      // Empty text cells go last in either direction.
      if (!col.numeric && !x !== !y) return x ? -1 : 1;
      const c = col.numeric ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
      return c * dir || a.id.localeCompare(b.id);
    });
}

function setSort(key) {
  const col = COLUMNS.find(c => c.key === key);
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: col.numeric ? -1 : 1 };
  savePrefs({ sort: state.sort });
  render();
}

function setFree(free) {
  state.free = free;
  render();
}

// The drag preview (or the editor's draft) stands in for the real booking, so lanes and row heights follow it live.
const previewBooking = () => drag?.preview ?? state.draft;
function renderedBookings() {
  const p = previewBooking();
  if (!p) return state.bookings;
  return p.isNew ? [...state.bookings, p] : state.bookings.map(b => (b.id === p.id ? p : b));
}
const draftFor = (pc, a, z) => ({ id: '__new', isNew: true, pc, user: defaultUser(), from: toIso(Math.min(a, z)), to: toIso(Math.max(a, z)) });

// ---------- rendering

function render() {
  const start = state.start;
  const end = start + state.days - 1;
  const t = today();
  const pcs = visiblePcs();
  const all = renderedBookings();
  const free = state.free;

  board.style.setProperty('--days', state.days);
  board.style.setProperty('--w', `${W}px`);
  renderFreeChip();

  const frag = document.createDocumentFragment();
  frag.append(renderHead(start, end, t));

  for (const pc of pcs) {
    const visible = bookingsFor(pc.id, all).filter(b => overlaps(b, start, end));
    const { lanes, count } = assignLanes(visible);
    const row = h('div', 'row');
    row.dataset.pc = pc.id;
    if (drag?.preview?.pc === pc.id && drag.moved) row.classList.add('target');
    row.append(renderPc(pc, t));

    const track = h('div', 'track');
    track.dataset.pc = pc.id;
    track.style.minHeight = `${count * LANE + 8}px`;
    if (t >= start && t <= end) track.append(column('today-col', t, t, start));
    if (free) {
      const a = Math.max(free.from, start), z = Math.min(free.to, end);
      if (a <= z) track.append(column('free-col', a, z, start));
    }
    for (const b of visible) track.append(renderBar(b, lanes.get(b.id), start, end));
    row.append(track);
    frag.append(row);
  }

  if (!pcs.length) {
    frag.append(h('div', 'empty', !state.pcs.length ? 'Loading…' : free?.applied ? `No PC is free ${fmtRange(free.from, free.to)}.` : 'No PC matches your search.'));
  }
  board.replaceChildren(frag);
  updateTitle();
}

function column(cls, a, z, start) {
  const col = h('div', cls);
  col.style.left = `${(a - start) * W}px`;
  col.style.width = `${(z - a + 1) * W}px`;
  return col;
}

function renderFreeChip() {
  const el = $('#free');
  el.replaceChildren();
  const f = state.free;
  if (f?.applied) {
    el.className = 'chip';
    el.append(h('span', null, `Free ${fmtRange(f.from, f.to)}`));
    const x = h('button', 'chip-x', '×');
    x.title = 'Clear (Esc)';
    x.setAttribute('aria-label', 'Clear free-date filter');
    x.onclick = () => setFree(null);
    el.append(x);
  } else {
    el.className = 'hint';
    el.textContent = 'Drag across dates to find free PCs';
  }
}

function renderHead(start, end, t) {
  const head = h('div', 'head');
  const corner = h('div', 'pc corner');
  for (const col of COLUMNS) {
    const active = state.sort.key === col.key;
    const btn = h('button', `sort c-${col.key}${col.right ? ' right' : ''}${active ? ' active' : ''}`);
    btn.type = 'button';
    btn.title = col.key === 'gpu' ? 'Sort by VRAM' : `Sort by ${col.label}`;
    btn.append(h('span', null, col.label), h('span', 'arrow', active ? (state.sort.dir > 0 ? '▲' : '▼') : ''));
    btn.onclick = () => setSort(col.key);
    corner.append(btn);
  }
  head.append(corner);

  const cal = h('div', 'cal');
  const months = h('div', 'months');
  for (let d = start; d <= end;) {
    const next = Math.min(end + 1, d + daysLeftInMonth(d));
    const m = h('div', 'month');
    m.append(h('span', null, fmtMonth(d)));
    m.style.width = `${(next - d) * W}px`;
    months.append(m);
    d = next;
  }
  const days = h('div', 'days');
  const f = state.free;
  for (let d = start; d <= end; d++) {
    const wd = weekday(d);
    const c = h('div', 'day');
    c.dataset.day = d;
    if (wd >= 5) c.classList.add('weekend');
    if (d === t) c.classList.add('today');
    if (f && d >= f.from && d <= f.to) {
      c.classList.add('sel');
      if (d === f.from) c.classList.add('sel-start');
      if (d === f.to) c.classList.add('sel-end');
    }
    c.append(h('span', 'wd', WEEKDAYS[wd]), h('span', 'dn', String(dayOfMonth(d))));
    days.append(c);
  }
  cal.append(months, days);
  head.append(cal);
  return head;
}

function daysLeftInMonth(d) {
  const date = new Date(d * DAY);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return last - date.getUTCDate() + 1;
}

function renderPc(pc, t) {
  const now = bookingsFor(pc.id).filter(b => overlaps(b, t, t));
  const status = !now.length ? 'free' : now.every(b => b.preemptible) ? 'soft' : 'busy';
  const cell = h('div', 'pc');
  cell.title = [
    `${pc.id}: ${pc.gpu} (${pc.vram} GB), ${pc.ram} GB RAM`,
    place(pc),
    pc.setup && `Setup: ${pc.setup}`,
    pc.netboot ? 'Netboot' : 'No netboot',
    pc.responsible && `Responsible: ${pc.responsible}`,
    pc.notes,
    `Today: ${now.length ? now.map(label).join(', ') : 'free'}`,
  ].filter(Boolean).join('\n');

  const name = h('span', 'name c-id');
  name.append(h('span', `dot ${status}`), h('strong', null, pc.id));

  const gpu = h('span', 'gpu c-gpu');
  gpu.append(h('span', 'gpu-name', shortGpu(pc.gpu)), h('span', 'tag vram', `${pc.vram} GB`));

  const loc = h('span', 'loc c-location');
  const where = h('span', 'loc-name');
  if (pc.room) where.append(h('span', 'room', pc.room), ' ');
  where.append(pc.location || '');
  loc.append(where);
  if (pc.setup) {
    const tag = h('span', 'tag setup', pc.setup);
    tag.title = `Setup: ${pc.setup}`;
    loc.append(tag);
  }

  cell.append(
    name,
    gpu,
    h('span', 'num c-ram', `${pc.ram} GB`),
    loc,
    h('span', `c-netboot ${pc.netboot ? 'muted' : 'nb off'}`, pc.netboot ? 'Yes' : 'No'),
    h('span', 'c-responsible', pc.responsible || ''),
  );
  return cell;
}

function renderBar(b, lane, start, end) {
  const f = toDay(b.from), t = toDay(b.to);
  const a = Math.max(f, start), z = Math.min(t, end);
  const isPreview = previewBooking()?.id === b.id;
  const e = h('button', 'bar');
  e.type = 'button';
  e.dataset.id = b.id;
  e.style.setProperty('--hue', hue(b.user || '?'));
  e.style.top = `${lane * LANE + 4}px`;
  e.style.left = `${(a - start) * W + 2}px`;
  e.style.width = `${(z - a + 1) * W - 4}px`;
  e.classList.toggle('cut-l', f < start);
  e.classList.toggle('cut-r', t > end);
  if (b.preemptible) e.classList.add('preemptible');
  if (state.me && b.createdBy === state.me.login) e.classList.add('mine');
  if (b.id === state.appear) e.classList.add('appear');
  if (b.id === state.settlingId) e.style.visibility = 'hidden';
  let text = label(b);
  if (isPreview && b.isNew) {
    e.classList.add('ghost');
    text = `${b.user || 'New booking'} · ${fmtRange(f, t)}`;
  } else if (isPreview) {
    e.classList.add('placeholder');
    text = fmtRange(f, t);
  }
  e.append(h('span', 'who', text));
  e.title = describe(b);
  e.setAttribute('aria-label', describe(b).replaceAll('\n', ', '));
  return e;
}

// Greedy interval colouring: overlapping bookings on one PC stack into lanes.
function assignLanes(bs) {
  const ends = [];
  const lanes = new Map();
  for (const b of [...bs].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to))) {
    let i = ends.findIndex(e => e < b.from);
    if (i < 0) i = ends.length;
    ends[i] = b.to;
    lanes.set(b.id, i);
  }
  return { lanes, count: Math.max(1, ends.length) };
}

// ---------- continuous timeline

function visibleSpan() {
  const pane = board.querySelector('.corner')?.offsetWidth ?? 0;
  const first = state.start + Math.floor(board.scrollLeft / W);
  const n = Math.max(1, Math.floor((board.clientWidth - pane) / W));
  return { first, last: first + n - 1, n };
}

function updateTitle() {
  const { first, last } = visibleSpan();
  $('#range-label').textContent = fmtMonthSpan(first, last);
}

// The window holds a full screen of extra days on each side, so a page step always has room and re-centring never has to undo itself.
function fitWindow() {
  const n = Math.ceil(board.clientWidth / W);
  const days = Math.max(MIN_DAYS, Math.ceil((3 * n + 2 * MARGIN) / 7) * 7);
  if (days === state.days) return false;
  state.days = days;
  return true;
}

// Window start that puts `first` (the first visible day) in the middle of the window; Monday-aligned for the weekend stripes.
const centredStart = (first, n) => mondayOf(first - Math.floor((state.days - n) / 2));

// Once less than a screen of timeline remains on either side, re-centre the window around the view. The scroll offset is compensated, so nothing on screen moves.
function recenter() {
  if (drag || settling) return;
  const { first, n } = visibleSpan();
  const lead = first - state.start;
  const tail = state.start + state.days - (first + n);
  if (lead < n || tail < n) shiftWindow(centredStart(first, n));
}

// Move the window start, keeping the same days under the same pixels. Returns the shift in days.
function shiftWindow(start) {
  const shift = start - state.start;
  if (!shift) return 0;
  const left = board.scrollLeft;
  state.start = start;
  render();
  board.scrollLeft = left - shift * W;
  return shift;
}

let scrollIdle;
board.addEventListener('scroll', () => {
  board.classList.toggle('scrolled-x', board.scrollLeft > 0);
  board.classList.toggle('scrolled-y', board.scrollTop > 0);
  updateTitle();
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => { pageTarget = null; recenter(); }, 150);
}, { passive: true });

let resizeIdle;
window.addEventListener('resize', () => {
  clearTimeout(resizeIdle);
  resizeIdle = setTimeout(() => {
    if (fitWindow()) render();
    recenter();
  }, 150);
});

const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');

// Clicks during a smooth scroll add up from where the previous click was heading, not from the half-way position.
let pageTarget = null;
function page(dir) {
  const { n } = visibleSpan();
  const step = Math.max(7, Math.floor(n / 7) * 7 - 7);
  let target = (pageTarget ?? board.scrollLeft) + dir * step * W;
  // Quick repeated clicks can outrun the idle re-centre; re-window around the destination first.
  const first = state.start + Math.round(target / W);
  if (first < state.start || first + n > state.start + state.days) target -= shiftWindow(centredStart(first, n)) * W;
  pageTarget = Math.min(board.scrollWidth - board.clientWidth, Math.max(0, target));
  board.scrollTo({ left: pageTarget, behavior: scrollBehavior() });
}

function goToDay(d, smooth = true) {
  const first = d - 2;
  const { n } = visibleSpan();
  if (first - state.start < n || state.start + state.days - (first + n) < n) {
    state.start = centredStart(first, n);
    render();
    smooth = false;
  }
  board.scrollTo({ left: (first - state.start) * W, behavior: smooth ? scrollBehavior() : 'auto' });
}

// ---------- data

const ops = {
  add: b => list => [...list, b],
  update: (id, patch) => list => list.map(b => (b.id === id ? { ...b, ...patch, ...stamp('updated') } : b)),
  remove: id => list => list.filter(b => b.id !== id),
};

function stamp(kind) {
  return {
    [`${kind}By`]: state.me?.login ?? 'demo',
    [`${kind}At`]: new Date().toISOString(),
  };
}

// Writes go through one queue so each commit sees the previous one; the server result only replaces local state once nothing else is in flight.
function commit(op, message, appear = null) {
  state.bookings = op(state.bookings);
  state.appear = appear;
  render();
  state.appear = null;
  pending++;
  setSync('Saving…');
  queue = queue
    .then(() => store.mutate(op, message))
    .then(next => {
      if (--pending === 0) { state.bookings = next; state.syncedAt = new Date(); render(); syncedLabel(); }
    })
    .catch(async err => {
      pending--;
      if (err instanceof AuthError) return requireSignIn();
      toast(`Couldn't save: ${err.message}`);
      await refresh(true);
    });
}

async function refresh(force = false) {
  if (!store || (!force && (drag || editor.open || pending))) return;
  try {
    const { pcs, bookings } = await store.load();
    state.pcs = pcs;
    state.bookings = bookings;
    state.syncedAt = new Date();
    render();
    syncedLabel();
  } catch (err) {
    if (err instanceof AuthError) return requireSignIn();
    setSync('Offline');
    toast(err.message);
  }
}

// ---------- editor
// It grows out of whatever was clicked and shrinks back into it; a new booking stays visible behind it as a ghost that follows the form.

function defaultUser() {
  return prefs.lastUser || state.me?.name || '';
}

function openEditor(b, origin = lastPointer) {
  editing = b;
  const isNew = !b.id || b.isNew;
  $('#editor-title').textContent = isNew ? 'New booking' : 'Edit booking';
  form.pc.replaceChildren(...state.pcs.map(p => new Option(`${p.id} · ${shortGpu(p.gpu)} · ${p.vram} GB`, p.id)));
  form.pc.value = b.pc ?? visiblePcs()[0]?.id ?? state.pcs[0]?.id;
  form.user.value = b.user ?? defaultUser();
  form.from.value = b.from;
  form.to.value = b.to;
  form.note.value = b.note ?? '';
  form.preemptible.checked = !!b.preemptible;
  $('#editor-delete').hidden = isNew;

  people = [...new Set([...state.bookings.map(x => x.user), ...state.pcs.map(p => p.responsible)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const meta = [];
  if (b.createdBy) meta.push(`Created by ${b.createdBy}${b.createdAt ? ` on ${new Date(b.createdAt).toLocaleDateString()}` : ''}`);
  if (b.updatedBy) meta.push(`last changed by ${b.updatedBy}`);
  $('#editor-meta').textContent = meta.join(', ');

  state.draft = isNew ? draftFor(form.pc.value, toDay(b.from), toDay(b.to)) : null;
  if (isNew) render();
  updateConflict();

  editor.showModal();
  const r = editor.getBoundingClientRect();
  editor.style.transformOrigin = origin ? `${origin.x - r.left}px ${origin.y - r.top}px` : 'center';
  editor.animate(editorFrames(), { duration: 300, easing: EASE_OUT });
  (isNew ? form.user : form.from).focus();
}

const editorFrames = () => (reducedMotion.matches
  ? [{ opacity: 0 }, { opacity: 1 }]
  : [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }]);

function closeEditor() {
  if (!editor.open || editor.classList.contains('closing')) return;
  editor.classList.add('closing');
  editor.animate(editorFrames().reverse(), { duration: 180, easing: EASE_IN, fill: 'forwards' })
    .finished.catch(() => {}).finally(() => {
      editor.close();
      editor.classList.remove('closing');
      editor.getAnimations().forEach(a => a.cancel());
    });
}

editor.addEventListener('close', () => {
  editing = null;
  if (state.draft) { state.draft = null; render(); }
});
editor.addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
// Clicking the scrim dismisses, like a popover.
editor.addEventListener('click', e => {
  if (e.target !== editor) return;
  const r = editor.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeEditor();
});

function updateConflict() {
  const el = $('#editor-conflict');
  form.to.min = form.from.value;
  if (!form.from.value || !form.to.value || !form.pc.value) { el.hidden = true; return; }
  const c = conflicts(form.pc.value, toDay(form.from.value), toDay(form.to.value), editing?.isNew ? null : editing?.id);
  el.hidden = !c.length;
  el.textContent = c.length
    ? `Overlaps with ${c.map(b => `${label(b)} (${fmtRange(toDay(b.from), toDay(b.to))}${b.preemptible ? ', preemptible' : ''})`).join('; ')}`
    : '';
}

// Inline completion, like Mail's To: field: typing fills in the rest of a known name, selected, so typing on simply replaces it and Tab accepts it. No popup to misplace.
let people = [];
form.user.addEventListener('input', e => {
  if (e.isComposing || !e.inputType?.startsWith('insert')) return;
  const typed = form.user.value;
  const at = form.user.selectionStart;
  if (!typed || at !== typed.length) return;
  const match = people.find(p => p.length > typed.length && p.toLowerCase().startsWith(typed.toLowerCase()));
  if (!match) return;
  form.user.value = match;
  form.user.setSelectionRange(typed.length, match.length, 'backward');
});

form.addEventListener('input', () => {
  updateConflict();
  const d = state.draft;
  if (!d || !form.from.value || !form.to.value || form.to.value < form.from.value) return;
  Object.assign(d, { pc: form.pc.value, from: form.from.value, to: form.to.value, user: form.user.value.trim() });
  render();
});

form.addEventListener('submit', e => {
  e.preventDefault();
  if (e.submitter?.value !== 'save') return closeEditor();
  if (form.to.value < form.from.value) {
    form.to.setCustomValidity('Must be on or after the start date');
    form.to.reportValidity();
    form.to.setCustomValidity('');
    return;
  }
  const fields = {
    pc: form.pc.value,
    user: form.user.value.trim(),
    from: form.from.value,
    to: form.to.value,
    note: form.note.value.trim() || undefined,
    preemptible: form.preemptible.checked || undefined,
  };
  savePrefs({ lastUser: fields.user });
  const what = `${fields.user} on ${fields.pc}, ${fields.from} → ${fields.to}`;
  if (editing.isNew || !editing.id) {
    // The ghost turns into the real bar in place.
    state.draft = null;
    const b = JSON.parse(JSON.stringify({ id: crypto.randomUUID(), ...fields, ...stamp('created') }));
    commit(ops.add(b), `Book ${what}`, b.id);
  } else {
    commit(ops.update(editing.id, fields), `Update booking: ${what}`);
  }
  closeEditor();
});

$('#editor-delete').addEventListener('click', () => {
  const b = editing;
  closeEditor();
  deleteBooking(b);
});

function deleteBooking(b) {
  commit(ops.remove(b.id), `Delete booking: ${b.user} on ${b.pc}, ${b.from} → ${b.to}`);
  toast(`Deleted ${b.user} on ${b.pc}`, { label: 'Undo', run: () => commit(ops.add(b), `Restore booking: ${b.user} on ${b.pc}`, b.id) });
}

// ---------- pointer interaction
// Mouse/pen: press empty days to create (the ghost shows on press, dragging extends it), grab a bar to move it (also onto another PC) or its edges to resize, drag across the day header to pick free dates.
// A grabbed bar follows the pointer 1:1 from where it was grabbed, while a dashed placeholder shows where it will land; on release it glides into that slot.
// Touch keeps native scrolling and uses taps instead.

const dayAt = x => state.start + Math.floor((x - board.querySelector('.days').getBoundingClientRect().left) / W);

document.addEventListener('pointerdown', e => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

board.addEventListener('pointerdown', e => {
  settling?.finish();
  suppressClick = false;
  if (e.button !== 0 || e.pointerType === 'touch' || !store) return;
  const day = e.target.closest('.day');
  const track = e.target.closest('.track');
  const bar = e.target.closest('.bar');
  if (day) {
    drag = { kind: 'range', anchor: Number(day.dataset.day) };
  } else if (bar) {
    const r = bar.getBoundingClientRect();
    const x = e.clientX - r.left;
    const kind = x < 8 && !bar.classList.contains('cut-l') ? 'start'
      : x > r.width - 8 && !bar.classList.contains('cut-r') ? 'end' : 'move';
    drag = { kind, b: byId(bar.dataset.id), el: bar, rect: r };
    bar.classList.add('pressed');
  } else if (track) {
    const d = dayAt(e.clientX);
    drag = { kind: 'create', pc: track.dataset.pc, anchor: d, preview: draftFor(track.dataset.pc, d, d) };
    render();
  } else {
    return;
  }
  Object.assign(drag, { x0: e.clientX, y0: e.clientY, s0: board.scrollLeft });
  e.preventDefault();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
  window.addEventListener('pointercancel', cancelDrag, { once: true });
});

function onMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    drag.moved = true;
    document.body.classList.add('dragging', `drag-${drag.kind}`);
    if (drag.el) lift();
  }
  autoScroll(e.clientX);

  if (drag.kind === 'range') {
    const d = dayAt(e.clientX);
    const from = Math.min(drag.anchor, d), to = Math.max(drag.anchor, d);
    if (state.free?.from !== from || state.free?.to !== to || state.free.applied) setFree({ from, to, applied: false });
    return;
  }

  let preview;
  if (drag.kind === 'create') {
    preview = draftFor(drag.pc, drag.anchor, dayAt(e.clientX));
  } else {
    follow(e);
    const f0 = toDay(drag.b.from), t0 = toDay(drag.b.to);
    // Content coordinates, so auto-scrolling while dragging still lands on the day under the pointer.
    const dd = Math.round((e.clientX - drag.x0 + board.scrollLeft - drag.s0) / W);
    let f = f0, t = t0, pc = drag.preview?.pc ?? drag.b.pc;
    if (drag.kind === 'move') {
      f += dd; t += dd;
      pc = document.elementFromPoint(e.clientX, e.clientY)?.closest('.row')?.dataset.pc ?? pc;
    } else if (drag.kind === 'start') {
      f = Math.min(f0 + dd, t0);
    } else {
      t = Math.max(t0 + dd, f0);
    }
    preview = { ...drag.b, pc, from: toIso(f), to: toIso(t) };
  }
  const p = drag.preview;
  if (p && p.pc === preview.pc && p.from === preview.from && p.to === preview.to && board.querySelector('.row.target')) return;
  drag.preview = preview;
  render();
}

// Detach a copy of the bar that tracks the pointer; the board keeps a placeholder where it will land.
function lift() {
  const r = drag.rect;
  const f = drag.el.cloneNode(true);
  f.classList.remove('pressed');
  f.classList.add('floating');
  f.removeAttribute('title');
  Object.assign(f.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  document.body.append(f);
  drag.float = f;
}

function follow(e) {
  const { rect: r, float: f, kind } = drag;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  const min = W - 4;
  if (kind === 'move') {
    f.style.transform = `translate(${dx}px, ${dy}px)`;
  } else if (kind === 'start') {
    const w = Math.max(min, r.width - dx);
    f.style.width = `${w}px`;
    f.style.transform = `translateX(${r.width - w}px)`;
  } else {
    f.style.width = `${Math.max(min, r.width + dx)}px`;
  }
}

// Glide the floating copy into the bar's final slot, then swap it for the real bar.
function settle(float, id) {
  if (!float) return;
  const target = barEl(id);
  if (!target || reducedMotion.matches) { float.remove(); return; }
  const from = float.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const baseX = parseFloat(float.style.left), baseY = parseFloat(float.style.top);
  state.settlingId = id;
  target.style.visibility = 'hidden';
  settling = float.animate([
    { transform: `translate(${from.left - baseX}px, ${from.top - baseY}px)`, width: `${from.width}px` },
    { transform: `translate(${to.left - baseX}px, ${to.top - baseY}px)`, width: `${to.width}px`, boxShadow: '0 0 0 transparent' },
  ], { duration: 260, easing: EASE_OUT, fill: 'forwards' });
  const done = () => {
    float.remove();
    settling = null;
    state.settlingId = null;
    const t = barEl(id);
    if (t) t.style.visibility = '';
  };
  settling.onfinish = done;
  settling.oncancel = done;
}

function suppressNextClick() {
  // Swallow the click that follows this pointerup, but don't let the flag outlive it (keyboard clicks have no pointerdown to reset it).
  suppressClick = true;
  setTimeout(() => { suppressClick = false; });
}

function onUp(e) {
  const d = endDrag();
  if (!d) return;
  if (d.kind === 'create') {
    suppressNextClick();
    return openEditor(d.preview, { x: e.clientX, y: e.clientY });
  }
  if (!d.moved) { d.el?.classList.remove('pressed'); return; }
  suppressNextClick();
  if (d.kind === 'range') return setFree({ ...state.free, applied: true });

  const p = d.preview;
  if (p && (p.from !== d.b.from || p.to !== d.b.to || p.pc !== d.b.pc)) {
    commit(ops.update(d.b.id, { from: p.from, to: p.to, pc: p.pc }), `Move booking: ${d.b.user} to ${p.pc}, ${p.from} → ${p.to}`);
  } else {
    render();
  }
  settle(d.float, d.b.id);
}

function endDrag() {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', cancelDrag);
  document.body.classList.remove('dragging', 'drag-create', 'drag-move', 'drag-start', 'drag-end', 'drag-range');
  return d;
}

// Esc: everything returns to where it came from.
function cancelDrag() {
  const d = endDrag();
  if (!d) return;
  if (d.moved || d.kind === 'create') suppressNextClick();
  if (d.kind === 'range' && d.moved) state.free = null;
  render();
  if (d.float) settle(d.float, d.b.id);
}

function autoScroll(x) {
  const r = board.getBoundingClientRect();
  const pane = board.querySelector('.corner')?.offsetWidth ?? 0;
  if (x > r.right - 40) board.scrollLeft += 16;
  else if (x < r.left + pane + 40) board.scrollLeft -= 16;
}

board.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  if (!store) return;
  const day = e.target.closest('.day');
  if (day) {
    const d = Number(day.dataset.day);
    const f = state.free;
    return setFree(f?.applied && f.from === d && f.to === d ? null : { from: d, to: d, applied: true });
  }
  const bar = e.target.closest('.bar');
  if (bar) return openEditor(byId(bar.dataset.id), { x: e.clientX, y: e.clientY });
  const track = e.target.closest('.track');
  if (track) {
    const d = dayAt(e.clientX);
    openEditor(draftFor(track.dataset.pc, d, d), { x: e.clientX, y: e.clientY });
  }
});

board.addEventListener('keydown', e => {
  const bar = e.target.closest?.('.bar');
  if (bar && (e.key === 'Delete' || e.key === 'Backspace')) deleteBooking(byId(bar.dataset.id));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drag) return cancelDrag();
  if (editor.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && state.free) return setFree(null);
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'n') { e.preventDefault(); $('#new-booking').click(); }
  if (e.key === 't') $('#today').click();
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'ArrowLeft') page(-1);
  if (e.key === 'ArrowRight') page(1);
});

// ---------- toolbar

$('#prev').onclick = () => page(-1);
$('#next').onclick = () => page(1);
$('#today').onclick = () => goToDay(today());
$('#new-booking').onclick = () => {
  const f = state.free;
  const btn = $('#new-booking').getBoundingClientRect();
  const from = f?.from ?? today();
  openEditor({ pc: visiblePcs()[0]?.id, from: toIso(from), to: toIso(f?.to ?? from) }, { x: btn.left + btn.width / 2, y: btn.top + btn.height / 2 });
};
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#sync').onclick = () => refresh(true);

// ---------- account

function renderAccount() {
  const el = $('#account');
  el.replaceChildren();
  if (demo || !state.me) return;
  const img = h('img', 'avatar');
  img.src = state.me.avatar;
  img.alt = '';
  img.title = state.me.login;
  const out = h('button', 'pill', 'Sign out');
  out.onclick = () => { auth.signOut(); location.reload(); };
  el.append(img, out);
}

function requireSignIn() {
  auth.signOut();
  store = null;
  $('#signin').hidden = false;
}
$('#signin-btn').onclick = () => auth.signIn();

// ---------- boot

async function main() {
  fitWindow();
  render();
  if (demo) {
    $('#demo-badge').hidden = false;
    store = localStore();
  } else {
    try { await auth.completeSignIn(); } catch (err) { toast(err.message); }
    if (!auth.getSession()) return requireSignIn();
    store = githubStore(config.dataRepo, auth.accessToken);
    try {
      state.me = await store.whoami();
    } catch (err) {
      if (err instanceof AuthError) return requireSignIn();
      toast(err.message);
    }
    renderAccount();
  }
  await refresh(true);
  goToDay(today(), false);

  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}

main();
