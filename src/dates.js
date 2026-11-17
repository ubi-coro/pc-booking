// Dates are whole days since the Unix epoch (UTC), so DST never shifts anything.
// Bookings store ISO dates ("2026-11-17"); both ends inclusive, like the old sheet.
export const DAY = 864e5;

export const toDay = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
};
export const toIso = n => new Date(n * DAY).toISOString().slice(0, 10);
export const today = () => {
  const t = new Date();
  return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY;
};
// 0 = Monday … 6 = Sunday
export const weekday = n => (new Date(n * DAY).getUTCDay() + 6) % 7;
export const mondayOf = n => n - weekday(n);
export const dayOfMonth = n => new Date(n * DAY).getUTCDate();

export const overlaps = (b, from, to) => toDay(b.from) <= to && toDay(b.to) >= from;

const short = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const fmtShort = n => short.format(n * DAY);
export const fmtMonth = n => month.format(n * DAY);
export const fmtRange = (from, to) => from === to ? fmtShort(from) : `${fmtShort(from)} – ${fmtShort(to)}`;

const monthOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' });
// Title for a visible span: "November 2026", "November – December 2026", "December 2026 – January 2027".
export function fmtMonthSpan(a, b) {
  const da = new Date(a * DAY), db = new Date(b * DAY);
  if (da.getUTCFullYear() !== db.getUTCFullYear()) return `${fmtMonth(a)} – ${fmtMonth(b)}`;
  if (da.getUTCMonth() !== db.getUTCMonth()) return `${monthOnly.format(da)} – ${fmtMonth(b)}`;
  return fmtMonth(a);
}

// Form dates are always shown as DD/MM/YYYY, independent of browser/OS locale.
const pad = n => String(n).padStart(2, '0');
export const fmtDMY = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
export const fmtDMYLocal = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

// Lenient parser for typed dates: "17/11/2026", "17.11.26", "17-11", "1/2" → ISO, or null if not a real date. A missing year means the current one.
export function parseDMY(text) {
  const m = text.trim().match(/^(\d{1,2})[./\-\s](\d{1,2})(?:[./\-\s](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}
