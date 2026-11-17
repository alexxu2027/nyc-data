// Pure helpers for the detail drawer: endpoint paths, titles, "as of" times and number formats.
import type { DetailRef, EntityDetail, FeatureProps, LayerMeta } from '../types';

const enc = encodeURIComponent;

/**
 * The API path that holds a feature's detail, or null when the layer has none. Ids are
 * encoded whole, so ':' and '/' survive (the routes use `{id:path}`).
 */
export function detailUrl(def: DetailRef, id: string): string | null {
  if (def.type === 'entity') return `/api/entities/${enc(def.kind)}/${enc(id)}`;
  if (def.type === 'event') return `/api/events/${enc(def.source)}/${enc(id)}`;
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The headline for a feature, from its properties alone (the instant header). */
/** Shown routes for a few express / shuttle ids ("6X" is the 6 express, "GS" the 42 St shuttle). */
export const ROUTE_NAME: Record<string, string> = { '5X': '5 express', '6X': '6 express', '7X': '7 express', FX: 'F express', GS: '42 St shuttle', FS: 'Franklin Av shuttle', H: 'Rockaway Park shuttle', SI: 'SIR', SS: 'SIR' };

/** "F train", "6 express train", "42 St shuttle". */
export function trainName(route: string): string {
  const named = ROUTE_NAME[route];
  if (named) return /shuttle|SIR/.test(named) ? named : `${named} train`;
  return `${route} train`;
}

export function featureTitle(props: Partial<FeatureProps> | undefined, fallback: string): string {
  if (!props) return fallback;
  const street = str(props.street);
  if (str(props.title) === 'Collision' && street) return `Collision on ${street}`;
  // A subway train: "F train to Coney Island-Stillwell Av" (not its trip id).
  const route = str(props.route);
  if (route && 'next_name' in props) {
    const head = str(props.headsign);
    return `${trainName(route)}${head ? ` to ${head}` : ''}`;
  }
  return (
    str(props.name) ??
    str(props.headline) ??
    str(props.event) ??
    str(props.title) ??
    str(props.top_title) ??
    str(props.type) ??
    fallback
  );
}

/** Newest ISO time among the arguments (nulls and junk ignored). */
export function newest(...ts: Array<unknown>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const t of ts) {
    if (typeof t !== 'string') continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best;
}

/** The time the shown values describe: the reading time if there is one, else the layer's. */
export function asOfTime(
  props: Partial<FeatureProps> | undefined,
  detail: EntityDetail | undefined,
  meta: LayerMeta | null | undefined,
  now: number,
): string | null {
  const latest = detail ? Object.values(detail.latest).map((m) => m.observed_at) : [];
  // Tide: latest.predicted_ft is a forecast 24 h ahead, so skip readings in the future.
  const past = latest.filter((t) => Date.parse(t) <= now + 60_000);
  return (
    newest(props?.observed_at) ??
    newest(...past) ??
    newest(props?.starts_at) ??
    meta?.data_as_of ??
    meta?.updated_at ??
    null
  );
}

/** "+0.29" / "−0.10" (true minus sign). */
export function signed(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '--';
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s;
  return (v > 0 ? '+' : '−') + s;
}

/** Fixed digits or "--". */
export function fixed(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '--' : v.toFixed(digits);
}

/** "3 h 22 min", "45 min". */
export function fmtDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '--';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const BOROUGH_NAMES: Record<string, string> = {
  MN: 'Manhattan',
  BK: 'Brooklyn',
  QN: 'Queens',
  BX: 'Bronx',
  SI: 'Staten Island',
  XX: 'Outside NYC',
};

/** "Nov 14, 3:45 AM – Nov 16, 10:00 PM ET", or "FROM Nov 14, 3:45 AM ET" when open-ended. */
export function fmtRange(start: string, end: string | null, fmt: (ts: string) => string): string {
  if (!end) return `FROM ${fmt(start)}`;
  return `${fmt(start).replace(/ ET$/, '')} – ${fmt(end)}`;
}

/** Peak depth from a flood event title ("Flooding at X, 5.16 in"). */
export function depthFromTitle(title: string): number | null {
  const m = /([\d.]+)\s*in\s*$/i.exec(title);
  return m ? Number(m[1]) : null;
}

/** True when a summary's text was cut by the API (it ends in an ellipsis). */
export function isTrimmed(text: unknown): boolean {
  return typeof text === 'string' && /…\s*$/.test(text);
}
