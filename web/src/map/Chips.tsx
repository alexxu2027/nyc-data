// HTML chip markers (plan §7.3) for layers with `marker: chip`: weather (five borough points)
// and the tide gauge. Printed slips in Source Code Pro on the map, with a tick to the point.
import { Marker } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, useLayerView } from '../core';
import type { LayerFeature } from '../types';
import { glyphPath, isGlyph } from '../ui';
import type { MapController } from './controller';

export interface ChipContent {
  glyph: string | null;
  text: string;
  /** Secondary reading, e.g. the signed surge. */
  sub: string | null;
  label: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a chip reads, per layer. Pure. */
export function chipContent(layer: string, p: Record<string, unknown>, icon?: string): ChipContent {
  const name = String(p.name ?? p.id ?? '');
  if (layer === 'weather') {
    const t = num(p.temp_f);
    return {
      glyph: p.wet === true ? 'drop' : null,
      text: t === null ? '–°F' : `${Math.round(t)}°F`,
      sub: null,
      label: `${name}: ${t === null ? 'no reading' : `${Math.round(t)} degrees F`}${p.wet === true ? ', precipitation' : ''}`,
    };
  }
  if (layer === 'tide_gauge') {
    const lvl = num(p.water_level_ft);
    const s = num(p.surge_ft);
    const arrow = p.trend === 'rising' ? '▲' : p.trend === 'falling' ? '▼' : p.trend === 'steady' ? '■' : '';
    const surge = s === null ? null : `${s > 0 ? '+' : s < 0 ? '−' : '±'}${Math.abs(s).toFixed(1)}`;
    return {
      glyph: icon ?? 'wave',
      text: `${lvl === null ? '–' : lvl.toFixed(1)} FT${arrow ? ` ${arrow}` : ''}`,
      sub: surge,
      label: `${name}: water level ${lvl === null ? 'unknown' : `${lvl.toFixed(1)} feet`}${p.trend ? `, ${String(p.trend)}` : ''}${surge ? `, surge ${surge} feet` : ''}`,
    };
  }
  return { glyph: icon ?? null, text: name, sub: null, label: name };
}

function Glyph({ name }: { name: string }) {
  if (!isGlyph(name)) return null;
  return (
    <svg className="nl-chip-g" viewBox="0 0 16 16" aria-hidden="true">
      <path d={glyphPath(name)} fillRule="evenodd" />
    </svg>
  );
}

function ChipMarker({ ctl, layer, f, icon }: { ctl: MapController; layer: string; f: LayerFeature; icon?: string }) {
  const [el] = useState(() => {
    const d = document.createElement('div');
    d.className = 'nl-chip-anchor';
    return d;
  });
  const marker = useRef<Marker | null>(null);
  const g = f.geometry;
  const lng = g.type === 'Point' ? g.coordinates[0] : NaN;
  const lat = g.type === 'Point' ? g.coordinates[1] : NaN;
  const id = f.properties.id;
  const selected = useApp((s) => s.selection?.mode === 'feature' && s.selection.layer === layer && s.selection.id === id);
  const hovered = useApp((s) => s.hover?.layer === layer && s.hover.id === id);

  useEffect(() => {
    const m = new Marker({ element: el, anchor: 'bottom' });
    marker.current = m;
    return () => {
      m.remove();
      marker.current = null;
    };
  }, [el]);

  useEffect(() => {
    const m = marker.current;
    if (!m || !Number.isFinite(lng) || !Number.isFinite(lat)) return;
    m.setLngLat([lng, lat]);
    if (!m.getElement().isConnected) m.addTo(ctl.map);
  }, [ctl, lng, lat]);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const c = chipContent(layer, f.properties, icon);
  const st = useApp.getState;
  const enter = () => {
    st().setHover({ layer, id });
    const p = ctl.project(lng, lat);
    ctl.tooltip.set({ layer, id, props: f.properties, x: p.x, y: p.y });
  };
  const leave = () => {
    const h = st().hover;
    if (h && h.layer === layer && h.id === id) st().setHover(null);
    ctl.tooltip.set(null);
  };
  return createPortal(
    <button
      type="button"
      className={`nl-chip${selected ? ' is-sel' : ''}${hovered ? ' is-hover' : ''}`}
      aria-label={c.label}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation();
        st().select({ mode: 'feature', layer, id });
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      {c.glyph && <Glyph name={c.glyph} />}
      <span className="nl-chip-v">{c.text}</span>
      {c.sub && <span className="nl-chip-s">{c.sub}</span>}
    </button>,
    el,
  );
}

/** All chips of one layer; nothing while the layer is hidden. */
export function ChipLayer({ ctl, id }: { ctl: MapController; id: string }) {
  const v = useLayerView(id);
  if (!v.visible) return null;
  return (
    <>
      {v.features.map((f) => (
        <ChipMarker key={f.properties.id} ctl={ctl} layer={id} f={f} icon={v.def.style.icon} />
      ))}
    </>
  );
}
