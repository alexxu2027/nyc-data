// MapView (plan U5, §7): the live MapLibre map. Fills its slot; the Shell positions it.
// React's only jobs here: create the controller, feed it each layer's filtered features
// (setData only when `useLayerView(id).features` changes identity), and render the HTML
// overlays (controls, tooltip, chip markers).
import { useCallback, useEffect, useState } from 'react';
import { fmtTime, useApp, useLayerView } from '../core';
import { ChipLayer } from './Chips';
import { Controls } from './Controls';
import { MapController } from './controller';
import { Tooltip } from './Tooltip';
import './map.css';

function LayerSync({ ctl, id }: { ctl: MapController; id: string }) {
  const v = useLayerView(id);
  useEffect(() => {
    ctl.setLayer(id, v.visible, v.features);
  }, [ctl, id, v.visible, v.features]);
  return null;
}

/** "RADAR · 1:40 AM ET" over the map while a raster layer is on and has a frame. */
function RasterLabels() {
  const ids = useApp((s) => s.catalog?.layers.filter((l) => l.kind === 'raster').map((l) => l.id).join(',') ?? '');
  const insets = useApp((s) => s.insets);
  if (!ids) return null;
  return (
    <div className="nl-raster-labels" style={{ left: insets.left + 12, bottom: insets.bottom + 28 }}>
      {ids.split(',').map((id) => (
        <RasterLabel key={id} id={id} />
      ))}
    </div>
  );
}

function RasterLabel({ id }: { id: string }) {
  const visible = useApp((s) => s.visible.includes(id));
  const short = useApp((s) => s.catalog?.layers.find((l) => l.id === id)?.short ?? id);
  const asOf = useApp((s) => s.data[id]?.meta?.data_as_of ?? null);
  const stale = useApp((s) => s.data[id]?.meta?.note === 'STALE' || s.data[id]?.status === 'error');
  if (!visible || !asOf) return null;
  return (
    <div className={stale ? 'nl-raster-label is-stale' : 'nl-raster-label'} role="status">
      {short.toUpperCase()} · {fmtTime(asOf, 'time').toUpperCase()}
      {stale ? ' · STALE' : ''}
    </div>
  );
}

export function MapView() {
  const [ctl, setCtl] = useState<MapController | null>(null);
  const layers = useApp((s) => s.catalog?.layers);

  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const c = new MapController(el);
    // Dev-only handle for manual checks in the console.
    if (import.meta.env.DEV) (window as unknown as { __nlMap?: MapController }).__nlMap = c;
    setCtl(c);
    return () => {
      setCtl(null);
      c.destroy();
    };
  }, []);

  return (
    <div className="nl-map">
      <div ref={ref} className="nl-map-canvas" />
      {ctl && (
        <>
          {layers?.map((d) =>
            d.style.marker === 'chip' ? <ChipLayer key={d.id} ctl={ctl} id={d.id} /> : <LayerSync key={d.id} ctl={ctl} id={d.id} />,
          )}
          <Controls ctl={ctl} />
          <RasterLabels />
          <Tooltip ctl={ctl} />
        </>
      )}
    </div>
  );
}
