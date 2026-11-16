// Transcript-styled map controls (plan U5): zoom, compass and locate chips, placed inside the
// part of the map that the Shell's overlays leave free (store `insets`).
import { useState, useSyncExternalStore } from 'react';
import { useApp } from '../core';
import { Chip } from '../ui';
import type { MapController } from './controller';

type Locate = 'idle' | 'busy' | 'denied';

export function Controls({ ctl }: { ctl: MapController }) {
  const insets = useApp((s) => s.insets);
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
        <Chip onClick={() => ctl.resetNorth()} ariaLabel={bearing ? `Reset north (bearing ${bearing}°)` : 'North is up'}>
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
    </div>
  );
}
