// Simulate the sun (2026-11-17): see the light, the shadows and AUTO's day and night at any
// time, or run a whole day as a time-lapse. From the browser console:
//
//   nlSun.at('2026-11-17 14:00')     the sun at 2 PM (New York time)
//   nlSun.timelapse()                today, 5 AM to 9 PM, in 40 s
//   nlSun.timelapse({ from: '2026-06-21 04:00', hours: 18, seconds: 60 })
//   nlSun.stop()                     stop a time-lapse where it is
//   nlSun.live()                     back to the real clock
//
// Turn SUN on (or theme AUTO) to see it. Everything that draws the sun listens for the clock
// change (core/sun.ts SUN_CLOCK_EVENT), so each step shows at once. This is also the seam
// Phase 3 replay will drive.
import { fmtTime } from './time';
import { setSunClock, sunClock } from './sun';

const STEP_MS = 200; // 5 steps a second: smooth enough, and a shadow redraw is ~50 ms

/** "2026-11-17 14:00" in New York time → epoch ms (EST/EDT picked by trying both offsets). */
export function nyTime(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return Date.parse(text);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  for (const offset of [5, 4]) {
    const ms = Date.UTC(y, mo - 1, d, h + offset, mi);
    const shown = fmtTime(ms); // "2:00 PM ET"
    const hour12 = ((h + 11) % 12) + 1;
    if (shown.startsWith(`${hour12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`)) return ms;
  }
  return Date.UTC(y, mo - 1, d, h + 5, mi);
}

function toMs(t: string | number): number {
  return typeof t === 'number' ? t : nyTime(t);
}

/** 5 AM New York time on the day of `ms`. */
function fiveAm(ms: number): number {
  const day = new Date(ms - 5 * 3_600_000); // close enough to the NY date
  const ymd = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
  return nyTime(`${ymd} 05:00`);
}

export interface TimelapseOptions {
  /** Start time: epoch ms or "YYYY-MM-DD HH:MM" New York time. Default: 5 AM today. */
  from?: string | number;
  /** How many hours of sky to run. Default 16 (5 AM to 9 PM). */
  hours?: number;
  /** How long it takes, in real seconds. Default 40. */
  seconds?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;

export const nlSun = {
  /** Show the sun at a moment. */
  at(t: string | number): string {
    nlSun.stop();
    setSunClock(toMs(t));
    return `sun at ${fmtTime(sunClock(), 'datetime')}`;
  },
  /** Run a stretch of sky as a time-lapse. */
  timelapse(o: TimelapseOptions = {}): string {
    nlSun.stop();
    const from = o.from !== undefined ? toMs(o.from) : fiveAm(Date.now());
    const span = (o.hours ?? 16) * 3_600_000;
    const total = Math.max(1, (o.seconds ?? 40) * 1000);
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / total);
      setSunClock(from + k * span);
      if (k >= 1) nlSun.stop();
    };
    step();
    timer = setInterval(step, STEP_MS);
    return `time-lapse: ${fmtTime(from, 'datetime')} + ${span / 3_600_000} h in ${total / 1000} s`;
  },
  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
  /** Back to the real clock. */
  live(): string {
    nlSun.stop();
    setSunClock(null);
    return 'sun on the real clock';
  },
};

/** Put `nlSun` on window for the console. */
export function installSunSim(): () => void {
  (globalThis as { nlSun?: typeof nlSun }).nlSun = nlSun;
  return () => {
    nlSun.stop();
    delete (globalThis as { nlSun?: typeof nlSun }).nlSun;
  };
}

