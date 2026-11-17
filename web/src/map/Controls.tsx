// Transcript-styled map controls (plan U5): zoom, compass and locate chips, placed inside the
// part of the map that the Shell's overlays leave free (store `insets`). Plus the SUN mode
// (ADR-017) with a readout of where the sun is, and a one-time hint for rotating and tilting
// (tilting raises the buildings; there is no 3D button).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { fmtTime, useApp } from '../core';
import { compass, SUN_CLOCK_EVENT, sunClock, sunPosition, sunSimulated, sunTimes } from '../core/sun';
import { Chip } from '../ui';
import type { MapController } from './controller';
import { SHADOW_MIN_ZOOM } from './scene';

const DAY_MS = 86_400_000;
const SUN_NOTE =
  'Sun position for the map centre, now. Shadows (from zoom 15) are estimated from OpenStreetMap building heights: no trees or terrain, and they fall on the ground and lower roofs only.';

/** The readout's lines for a moment and place: "SUN 23° · SW", "SETS 4:35 PM ET" … */
export function sunLines(ms: number, lat: number, lng: number, zoom: number, simulated = false): string[] {
  const lines = sunLinesAt(ms, lat, lng, zoom);
  // A simulated clock (nlSun in the console) says so, with the time it shows.
  return simulated ? [`SIMULATED ${fmtTime(ms, 'datetime').toUpperCase()}`, ...lines] : lines;
}

function sunLinesAt(ms: number, lat: number, lng: number, zoom: number): string[] {
  const pos = sunPosition(ms, lat, lng);
  const today = sunTimes(ms, lat, lng);
  if (pos.altitude > 0) {
    const out = [`SUN ${Math.round(pos.altitude)}° UP · ${compass(pos.azimuth)}`];
    if (today.sunset && today.sunset > ms) out.push(`SETS ${fmtTime(today.sunset).toUpperCase()}`);
    if (zoom < SHADOW_MIN_ZOOM) out.push('ZOOM IN FOR SHADOWS');
    return out;
  }
  const rise = today.sunrise && today.sunrise > ms ? today.sunrise : sunTimes(ms + DAY_MS, lat, lng).sunrise;
  return ['SUN DOWN', ...(rise ? [`RISES ${fmtTime(rise).toUpperCase()}`] : [])];
}

const HINT_KEY = 'nl.rotateHintDone';

/** How to rotate and tilt, in this device's words. */
export function rotateHint(coarse: boolean): string[] {
  return coarse
    ? ['DRAG 2 FINGERS UP: 3D', 'TWIST 2 FINGERS: ROTATE']
    : ['CTRL + SCROLL: TILT INTO 3D', 'SHIFT + SCROLL: ROTATE', 'OR RIGHT-DRAG'];
}

/** From this zoom the buildings are worth tilting for, so the hint appears. */
export const HINT_ZOOM = 15;

function readDone(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Shown once at street zoom until the map has been tilted or turned (remembered per browser). */
function RotateHint({ turned }: { turned: boolean }) {
  const [done, setDone] = useState(readDone);
  if (turned && !done) setDone(true); // adjust during render
  useEffect(() => {
    if (!done) return;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // private window: the hint just shows again next time
    }
  }, [done]);
  if (done) return null;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return (
    <div className="nl-sun nl-hint" role="note">
      {rotateHint(coarse).map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function SunReadout() {
  const view = useApp((s) => s.view);
  const [now, setNow] = useState(sunClock);
  useEffect(() => {
    const update = () => setNow(sunClock());
    const t = setInterval(update, 60_000);
    window.addEventListener(SUN_CLOCK_EVENT, update);
    return () => {
      clearInterval(t);
      window.removeEventListener(SUN_CLOCK_EVENT, update);
    };
  }, []);
  return (
    <div className="nl-sun" role="status" title={SUN_NOTE}>
      {sunLines(now, view.lat, view.lng, view.zoom, sunSimulated()).map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

type Locate = 'idle' | 'busy' | 'denied';

export function Controls({ ctl }: { ctl: MapController }) {
  const insets = useApp((s) => s.insets);
  const scene = useApp((s) => s.scene);
  const view = useApp((s) => s.view);
  const setScene = useApp((s) => s.setScene);
  const bearing = useSyncExternalStore(ctl.bearing.subscribe, ctl.bearing.get, ctl.bearing.get);
  const [loc, setLoc] = useState<Locate>('idle');
  const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const locate = () => {
    if (!canLocate || loc === 'busy') return;
    setLoc('busy');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc('idle');
        useApp.getState().flyTo({ lng: p.coords.longitude, lat: p.coords.latitude, zoom: 15 });
      },
      () => setLoc('denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <div className="nl-ctrls" style={{ top: insets.top + 12, right: insets.right + 12 }}>
      <div className="nl-ctrl-group">
        <Chip onClick={() => ctl.zoomBy(1)} ariaLabel="Zoom in">
          +
        </Chip>
        <Chip onClick={() => ctl.zoomBy(-1)} ariaLabel="Zoom out">
          −
        </Chip>
      </div>
      <div className="nl-ctrl-group">
        <Chip onClick={() => ctl.resetNorth()} ariaLabel={bearing || view.pitch ? `North up and flat (bearing ${bearing}°)` : 'North is up'}>
          <span className="nl-compass" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden="true">
            N
          </span>
        </Chip>
        {canLocate && (
          <Chip
            onClick={locate}
            pressed={loc === 'busy'}
            ariaLabel={loc === 'denied' ? 'Location unavailable; try again' : 'Fly to my location'}
          >
            <span aria-hidden="true">{loc === 'busy' ? '…' : loc === 'denied' ? '×' : '◎'}</span>
          </Chip>
        )}
      </div>
      <div className="nl-ctrl-group">
        <Chip
          onClick={() => setScene({ sun: !scene.sun })}
          pressed={scene.sun}
          ariaLabel={scene.sun ? 'Turn off the sun and shadows' : 'Show the sun and building shadows'}
        >
          SUN
        </Chip>
      </div>
      {scene.sun && <SunReadout />}
      {view.zoom >= HINT_ZOOM && <RotateHint turned={bearing !== 0 || view.pitch > 0} />}
    </div>
  );
}
