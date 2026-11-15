// Plain, unstyled harness components so wave-2 builders have working neighbours.
// DevShell takes the same props as Shell; DevMap and DevDrawer take none.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoroughCode, FilterDef, FilterValue, LayerDef, LayerFeature } from '../types';
import { api } from './api';
import { effectiveFilters } from './filters';
import { useLayerHealth, useLayerView } from './selectors';
import { BOROUGH_ORDER, useApp } from './store';
import { fmtAgo, fmtInt, fmtTime } from './time';

const mono: CSSProperties = { fontFamily: 'monospace', fontSize: 12 };

function FilterControl({ layer, f, value }: { layer: string; f: FilterDef; value: FilterValue }) {
  const setFilter = useApp((s) => s.setFilter);
  if (f.type === 'toggle') {
    return (
      <label style={{ display: 'block' }}>
        <input type="checkbox" checked={value === true} onChange={(e) => setFilter(layer, f.key, e.target.checked)} />{' '}
        {f.label} {f.apply === 'server' ? '(server)' : ''}
      </label>
    );
  }
  if (f.type === 'select') {
    return (
      <label style={{ display: 'block' }}>
        {f.label} {f.apply === 'server' ? '(server)' : ''}{' '}
        <select value={String(value)} onChange={(e) => setFilter(layer, f.key, e.target.value)}>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const sel = new Set(Array.isArray(value) ? value : []);
  return (
    <div>
      {f.label}:{' '}
      {(f.options ?? []).map((o) => (
        <label key={o.value} style={{ marginRight: 8 }}>
          <input
            type="checkbox"
            checked={sel.has(o.value)}
            onChange={(e) => {
              const next = (f.options ?? [])
                .map((x) => x.value)
                .filter((v) => (v === o.value ? e.target.checked : sel.has(v)));
              setFilter(layer, f.key, next);
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function DevLayerRow({ def }: { def: LayerDef }) {
  const v = useLayerView(def.id);
  const health = useLayerHealth(def.id);
  const overrides = useApp((s) => s.filters[def.id]);
  const toggleLayer = useApp((s) => s.toggleLayer);
  const resetFilters = useApp((s) => s.resetFilters);
  const select = useApp((s) => s.select);
  const [open, setOpen] = useState(false);
  const values = effectiveFilters(def, overrides);
  return (
    <li style={{ marginBottom: 4 }} data-layer={def.id}>
      <label>
        <input type="checkbox" checked={v.visible} onChange={() => toggleLayer(def.id)} /> {def.label}
      </label>{' '}
      <span data-testid={`count-${def.id}`}>
        {fmtInt(v.count)}/{fmtInt(v.total)}
      </span>{' '}
      [{v.status}] [health {health}] {v.meta?.truncated ? `[truncated of ${fmtInt(v.meta.total)}]` : ''}{' '}
      {v.meta?.unlocated ? `[unlocated ${v.meta.unlocated}]` : ''}{' '}
      <button onClick={() => setOpen(!open)}>{open ? '[-]' : '[+]'}</button>
      {def.list && (
        <button disabled={!v.visible} onClick={() => select({ mode: 'list', layer: def.id })}>
          [LIST]
        </button>
      )}
      {v.error && <div style={{ color: 'red' }}>error: {v.error}</div>}
      {v.visible && v.status === 'ready' && v.count === 0 && def.empty_text && <div>{def.empty_text}</div>}
      {open && (
        <div style={{ paddingLeft: 16 }}>
          {def.filters.map((f) => (
            <FilterControl key={f.key} layer={def.id} f={f} value={values[f.key]} />
          ))}
          {def.filters.length > 0 && <button onClick={() => resetFilters(def.id)}>[RESET]</button>}
          <div>
            as of {v.meta?.data_as_of ? fmtTime(v.meta.data_as_of, 'datetime') : '—'}; fetched{' '}
            {v.fetchedAt ? fmtAgo(v.fetchedAt) : '—'}; next {v.nextAt ? fmtTime(v.nextAt) : '—'}; poll{' '}
            {def.poll_s}s
          </div>
          {def.lag_note && <div>{def.lag_note}</div>}
          <div>
            <a href={def.attribution.url}>{def.attribution.text}</a>
          </div>
        </div>
      )}
    </li>
  );
}

export function DevShell({ map, drawer }: { map: ReactNode; drawer: ReactNode }) {
  const catalog = useApp((s) => s.catalog);
  const bootError = useApp((s) => s.bootError);
  const boroughs = useApp((s) => s.boroughs);
  const setBoroughs = useApp((s) => s.setBoroughs);
  const toggleBorough = useApp((s) => s.toggleBorough);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const health = useApp((s) => s.health);
  const selection = useApp((s) => s.selection);
  return (
    <div style={{ ...mono, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 4, borderBottom: '1px solid' }}>
        NYC LIVE (dev harness){' '}
        <button aria-pressed={boroughs.length === 0} onClick={() => setBoroughs([])}>
          {boroughs.length === 0 ? '[ALL]' : 'ALL'}
        </button>
        {BOROUGH_ORDER.map((b: BoroughCode) => (
          <button key={b} aria-pressed={boroughs.includes(b)} onClick={() => toggleBorough(b)}>
            {boroughs.includes(b) ? `[${b}]` : b}
          </button>
        ))}{' '}
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>theme: {theme}</button>{' '}
        {health
          ? `health ok ${health.summary.ok} stale ${health.summary.stale} degraded ${health.summary.degraded} never ${health.summary.never}`
          : 'health …'}
      </div>
      {bootError && <div style={{ color: 'red' }}>BOOT ERROR: {bootError}</div>}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: '44ch', overflow: 'auto', borderRight: '1px solid', padding: 4 }}>
          {!catalog && !bootError && <div>loading catalog…</div>}
          {catalog?.groups.map((g) => (
            <div key={g.id}>
              <div>== {g.label}</div>
              <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                {catalog.layers
                  .filter((l) => l.group === g.id)
                  .map((l) => (
                    <DevLayerRow key={l.id} def={l} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {map}
          {selection && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: '46ch',
                overflow: 'auto',
                background: 'Canvas',
                borderLeft: '1px solid',
              }}
            >
              {drawer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function pointOf(f: LayerFeature): [number, number] | null {
  return f.geometry?.type === 'Point' ? (f.geometry.coordinates as [number, number]) : null;
}

function DevMapLayer({ id }: { id: string }) {
  const v = useLayerView(id);
  const select = useApp((s) => s.select);
  const flyTo = useApp((s) => s.flyTo);
  const selected = useApp((s) => (s.selection?.mode === 'feature' && s.selection.layer === id ? s.selection.id : null));
  return (
    <div style={{ marginBottom: 8 }}>
      <div>
        {id}: {fmtInt(v.count)} shown / {fmtInt(v.total)} loaded (rev {v.rev}, {v.status})
      </div>
      <div>
        {v.features.slice(0, 12).map((f) => {
          const p = pointOf(f);
          const name = String(f.properties.name ?? f.properties.title ?? f.properties.type ?? f.properties.id);
          return (
            <button
              key={f.properties.id}
              aria-pressed={selected === f.properties.id}
              onClick={() => {
                select({ mode: 'feature', layer: id, id: f.properties.id });
                if (p) flyTo({ lng: p[0], lat: p[1], zoom: 14 });
              }}
              style={{ margin: 1 }}
            >
              {selected === f.properties.id ? '>' : ''}
              {name.slice(0, 28)}
            </button>
          );
        })}
        {v.count > 12 && <span> … {fmtInt(v.count - 12)} more</span>}
      </div>
    </div>
  );
}

export function DevMap() {
  const visible = useApp((s) => s.visible);
  const view = useApp((s) => s.view);
  const fly = useApp((s) => s.fly);
  return (
    <div style={{ ...mono, position: 'absolute', inset: 0, overflow: 'auto', padding: 4 }}>
      <div>
        view {view.lng.toFixed(5)},{view.lat.toFixed(5)} z{view.zoom.toFixed(2)} b{view.bearing} p{view.pitch}
        {fly ? ` | last fly ${fly.lng.toFixed(4)},${fly.lat.toFixed(4)} #${fly.nonce}` : ''}
      </div>
      {visible.length === 0 && <div>no layers visible</div>}
      {visible.map((id) => (
        <DevMapLayer key={id} id={id} />
      ))}
    </div>
  );
}

type Fetched = { key: string; data?: unknown; error?: string };

export function DevDrawer() {
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const def = useApp((s) => (s.selection ? s.catalog?.layers.find((l) => l.id === s.selection?.layer) : undefined));
  const feature = useApp((s) => {
    const sel = s.selection;
    if (!sel || sel.mode !== 'feature') return undefined;
    return s.data[sel.layer]?.features.find((f) => f.properties.id === sel.id);
  });
  const [fetched, setFetched] = useState<Fetched | null>(null);

  const key = selection ? JSON.stringify(selection) : '';
  const mode = selection?.mode ?? null;
  const layer = selection?.layer ?? null;
  const id = selection?.mode === 'feature' ? selection.id : null;
  const detailType = def?.detail.type ?? 'none';
  const detailArg = def ? (def.detail.type === 'entity' ? def.detail.kind : def.detail.type === 'event' ? def.detail.source : '') : '';
  useEffect(() => {
    let p: Promise<unknown> | null = null;
    if (mode === 'list' && layer) p = api.events(layer, { status: 'all' });
    else if (mode === 'feature' && id !== null && detailType === 'entity') p = api.entity(detailArg, id);
    else if (mode === 'feature' && id !== null && detailType === 'event') p = api.event(detailArg, id);
    if (!p) return;
    let live = true;
    p.then(
      (data) => live && setFetched({ key, data }),
      (e: unknown) => live && setFetched({ key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key, mode, layer, id, detailType, detailArg]);

  if (!selection) return null;
  const current = fetched?.key === key ? fetched : null;
  const noDetail = selection.mode === 'feature' && def?.detail.type === 'none';
  return (
    <div style={{ ...mono, padding: 4 }}>
      <button onClick={() => select(null)}>[CLOSE]</button>
      <pre style={{ whiteSpace: 'pre-wrap' }}>selection: {JSON.stringify(selection, null, 2)}</pre>
      {feature && <pre style={{ whiteSpace: 'pre-wrap' }}>properties: {JSON.stringify(feature.properties, null, 2)}</pre>}
      {noDetail ? (
        <div>no detail endpoint for this layer</div>
      ) : !current ? (
        <div>loading detail…</div>
      ) : current.error ? (
        <div style={{ color: 'red' }}>error: {current.error}</div>
      ) : (
        <pre style={{ whiteSpace: 'pre-wrap' }}>detail: {JSON.stringify(current.data, null, 2)}</pre>
      )}
    </div>
  );
}
