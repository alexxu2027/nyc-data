// Time formatting. Data is UTC; everything renders in America/New_York ("3:28 AM ET").
export const TZ = 'America/New_York';

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Epoch milliseconds from an ISO string, epoch ms, or epoch seconds (numbers below 1e11). */
export function toMs(ts: string | number): number {
  if (typeof ts === 'number') return ts < 1e11 ? ts * 1000 : ts;
  return Date.parse(ts);
}

/** "3:28 AM ET" (time), "Nov 15, 3:28 AM ET" (datetime), "Nov 15, 2026" (date). "—" if invalid. */
export function fmtTime(ts: string | number, style: 'time' | 'datetime' | 'date' = 'time'): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (style === 'date') return dateFmt.format(d);
  // ICU puts a narrow no-break space before AM/PM; normalise to a plain space.
  const t = `${timeFmt.format(d).replace(/\s/g, ' ')} ET`;
  return style === 'datetime' ? `${dayFmt.format(d)}, ${t}` : t;
}

/** "just now", "45 s ago", "12 min ago", "3 h ago", "2 d ago"; future times read "in 5 min". */
export function fmtAgo(ts: string | number, now: number = Date.now()): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return '—';
  const diff = Math.round((now - ms) / 1000);
  const abs = Math.abs(diff);
  let s: string;
  if (abs < 5) return 'just now';
  if (abs < 60) s = `${abs} s`;
  else if (abs < 3600) s = `${Math.floor(abs / 60)} min`;
  else if (abs < 86400 * 2) s = `${Math.floor(abs / 3600)} h`;
  else s = `${Math.floor(abs / 86400)} d`;
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

/** "20,000". */
export function fmtInt(n: number): string {
  return Number.isFinite(n) ? intFmt.format(n) : '—';
}
