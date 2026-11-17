// The sun's place in the sky (ADR-017): NOAA "General Solar Position Calculations". Good to well
// under 0.5° for shading, which is all this is for. Times are UTC instants (epoch ms); angles in
// degrees. Azimuth is clockwise from north (90 = east), altitude is above the horizon (no
// refraction, except the standard 0.833° in sunrise and sunset).

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

export interface SunPosition {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon (negative: below). */
  altitude: number;
}

interface Orbit {
  /** Equation of time, minutes. */
  eqtime: number;
  /** Declination, radians. */
  decl: number;
}

function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS + 1;
}

function daysInYear(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

function orbit(ms: number): Orbit {
  const d = new Date(ms);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / daysInYear(ms)) * (dayOfYear(ms) - 1 + (hour - 12) / 24);
  const eqtime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  return { eqtime, decl };
}

/** Where the sun is at `ms` for a place at `lat`, `lng` (degrees, east positive). */
export function sunPosition(ms: number, lat: number, lng: number): SunPosition {
  const { eqtime, decl } = orbit(ms);
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60_000;
  const tst = minutes + eqtime + 4 * lng; // true solar time, minutes
  const ha = (tst / 4 - 180) * RAD; // hour angle
  const phi = lat * RAD;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
  // From south, positive west; +180 turns it into clockwise from north.
  const fromSouth = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
  const azimuth = (((fromSouth / RAD + 180) % 360) + 360) % 360;
  return { azimuth, altitude };
}

export interface SunTimes {
  /** Epoch ms, or null on a day the sun doesn't rise or set (not at NYC's latitude). */
  sunrise: number | null;
  sunset: number | null;
}

/** Sunrise and sunset for the UTC day containing the local noon nearest `ms`. */
export function sunTimes(ms: number, lat: number, lng: number): SunTimes {
  // Local solar noon of this place's day, to pick the right UTC date and orbit.
  const noonGuess = Math.floor((ms + lng * 240_000) / DAY_MS) * DAY_MS + DAY_MS / 2 - lng * 240_000;
  const at = (event: 'rise' | 'set'): number | null => {
    let t = noonGuess;
    for (let i = 0; i < 2; i++) {
      const { eqtime, decl } = orbit(t);
      const phi = lat * RAD;
      const cosH = Math.cos(90.833 * RAD) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
      if (cosH < -1 || cosH > 1) return null;
      const h = Math.acos(cosH) / RAD;
      const minutes = 720 - 4 * (lng + (event === 'rise' ? h : -h)) - eqtime;
      const dayStart = Math.floor(noonGuess / DAY_MS) * DAY_MS;
      t = dayStart + minutes * 60_000;
    }
    return t;
  };
  return { sunrise: at('rise'), sunset: at('set') };
}

/**
 * The clock the sun is drawn for: now, unless `window.__nlSunTime` (epoch ms) is set. That's a
 * debugging hook for shadows at night, and the seam Phase 3 replay will drive.
 */
export function sunClock(): number {
  const t = (globalThis as { __nlSunTime?: unknown }).__nlSunTime;
  return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
}

/** Fired on window when the sun clock is set, so the light, shadows and theme redraw at once. */
export const SUN_CLOCK_EVENT = 'nl-sunclock';

/** Whether the sun is on a simulated clock (core/sunSim.ts). */
export function sunSimulated(): boolean {
  const t = (globalThis as { __nlSunTime?: unknown }).__nlSunTime;
  return typeof t === 'number' && Number.isFinite(t);
}

/** Set the sun clock (epoch ms), or null for the real clock, and tell everything to redraw. */
export function setSunClock(ms: number | null): void {
  const g = globalThis as { __nlSunTime?: number };
  if (ms === null) delete g.__nlSunTime;
  else g.__nlSunTime = ms;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SUN_CLOCK_EVENT));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "SW" for an azimuth. */
export function compass(azimuth: number): string {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8];
}
