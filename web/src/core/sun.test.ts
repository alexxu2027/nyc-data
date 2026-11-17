import { describe, expect, it } from 'vitest';
import { compass, sunPosition, sunTimes } from './sun';

const NYC = { lat: 40.7128, lng: -74.006 };
const RAD = Math.PI / 180;

/** An independent formula (Astronomy Answers, as in SunCalc) to cross-check NOAA's. */
function reference(ms: number, lat: number, lng: number) {
  const d = ms / 86_400_000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lng - ra;
  const phi = RAD * lat;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { altitude: alt / RAD, azimuth: (((az / RAD + 180) % 360) + 360) % 360 };
}

const maxAltitude = (dayUtc: string) => {
  let best = -90;
  const start = Date.parse(`${dayUtc}T12:00:00Z`);
  for (let m = 0; m < 12 * 60; m++) best = Math.max(best, sunPosition(start + m * 60_000, NYC.lat, NYC.lng).altitude);
  return best;
};

describe('sunPosition', () => {
  it('agrees with an independent formula: within 0.35° on the sky, all year', () => {
    // Compare directions, not azimuths: near overhead a tiny shift is a big azimuth change.
    const dir = (p: { azimuth: number; altitude: number }) => [
      Math.cos(p.altitude * RAD) * Math.sin(p.azimuth * RAD),
      Math.cos(p.altitude * RAD) * Math.cos(p.azimuth * RAD),
      Math.sin(p.altitude * RAD),
    ];
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 365 * 4; i++) {
      const ms = start + i * 6 * 3_600_000 + i * 997_000; // every ~6 h, drifting through the day
      const a = sunPosition(ms, NYC.lat, NYC.lng);
      const b = reference(ms, NYC.lat, NYC.lng);
      expect(Math.abs(a.altitude - b.altitude)).toBeLessThan(0.3);
      const [x1, y1, z1] = dir(a);
      const [x2, y2, z2] = dir(b);
      const sep = Math.acos(Math.min(1, x1 * x2 + y1 * y2 + z1 * z2)) / RAD;
      expect(sep).toBeLessThan(0.35);
    }
  });

  it("matches NYC's noon heights at the solstices and the equinox", () => {
    expect(maxAltitude('2026-06-21')).toBeCloseTo(90 - 40.7128 + 23.44, 0); // ≈ 72.7°
    expect(maxAltitude('2026-12-21')).toBeCloseTo(90 - 40.7128 - 23.44, 0); // ≈ 25.8°
    expect(Math.abs(maxAltitude('2026-03-20') - (90 - 40.7128))).toBeLessThan(0.6); // ≈ 49.3°
  });

  it('is in the south at solar noon, east in the morning, west in the evening', () => {
    expect(compass(sunPosition(Date.parse('2026-11-17T16:45:00Z'), NYC.lat, NYC.lng).azimuth)).toBe('S');
    expect(compass(sunPosition(Date.parse('2026-06-21T11:30:00Z'), NYC.lat, NYC.lng).azimuth)).toBe('E');
    expect(compass(sunPosition(Date.parse('2026-06-21T23:00:00Z'), NYC.lat, NYC.lng).azimuth)).toBe('W');
    expect(sunPosition(Date.parse('2026-11-17T05:00:00Z'), NYC.lat, NYC.lng).altitude).toBeLessThan(-30); // midnight
  });
});

describe('sunTimes', () => {
  it('gives NYC sunrise and sunset for a November day (EST = UTC-5)', () => {
    const t = sunTimes(Date.parse('2026-11-17T17:00:00Z'), NYC.lat, NYC.lng);
    const local = (ms: number | null) => (ms! - Date.parse('2026-11-17T05:00:00Z')) / 60_000; // minutes after local midnight
    expect(local(t.sunrise)).toBeGreaterThan(6 * 60 + 35);
    expect(local(t.sunrise)).toBeLessThan(6 * 60 + 50);
    expect(local(t.sunset)).toBeGreaterThan(16 * 60 + 25);
    expect(local(t.sunset)).toBeLessThan(16 * 60 + 40);
    // At sunrise the sun is at the horizon (-0.833° with refraction).
    expect(sunPosition(t.sunrise!, NYC.lat, NYC.lng).altitude).toBeCloseTo(-0.833, 0);
  });

  it('the same day whether asked in the morning or at night (local)', () => {
    const a = sunTimes(Date.parse('2026-11-17T12:00:00Z'), NYC.lat, NYC.lng); // 7 AM EST
    const b = sunTimes(Date.parse('2026-11-18T03:00:00Z'), NYC.lat, NYC.lng); // 10 PM EST, still the 17th
    expect(Math.abs(a.sunset! - b.sunset!)).toBeLessThan(60_000);
  });
});
