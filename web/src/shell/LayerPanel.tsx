// The layer panel (U4): groups, one row per layer, an expandable block with the legend,
// filters, timing, notes, attribution and actions. Reads and writes only the store.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, applyClientFilters, fmtAgo, fmtInt, fmtTime, useApp, useLayerHealth, useLayerView } from '../core';
import type { FilterDef, FilterValue, LayerDef, LegendItem } from '../types';
import { Banner, Blank, Check, FreshDot, Line, Num, Radio, Readout, Swatch, TextButton, type FreshState } from '../ui';
import {
  allEnum,
  controlValue,
  countBy,
  enumIsAll,
  enumSelected,
  fmtCountdown,
  fmtDuration,
  fmtPoll,
  groupLayers,
  nextEnum,
  nextSelect,
  nextToggle,
  planLegend,
  rowState,
  type RowNote,
} from './helpers';
import { useNow } from './hooks';
import { RasterControls, rasterStatus, type RasterStatus } from './RasterControls';

export interface LayerPanelProps {
  expanded: ReadonlySet<string>;
  onExpand: (id: string, open: boolean) => void;
}

/** The panel's lines. The caller wraps them in a numbered Panel (desktop) or a Sheet (phone). */
export function LayerPanelBody({ expanded, onExpand }: LayerPanelProps) {
  const catalog = useApp((s) => s.catalog);
  const bootError = useApp((s) => s.bootError);
  const visibleCount = useApp((s) => s.visible.length);
  const groups = useMemo(() => (catalog ? groupLayers(catalog) : []), [catalog]);

  if (!catalog) {
    return bootError ? (
      <>
        <Line>
          <Banner tone="warn">LAYER CATALOG UNAVAILABLE</Banner>
        </Line>
        <Line muted>{bootError}</Line>
      </>
    ) : (
      <>
        <Line right={<FreshDot state="loading" />}>
          <span className="print-in">LOADING THE LAYER CATALOG</span>
        </Line>
        <PlaceholderRows />
      </>
    );
  }

  return (
    <>
      <Line muted right={<span>{fmtInt(catalog.layers.length)} LAYERS</span>}>
        <Num value={visibleCount} width={2} /> ON
      </Line>
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          <Blank />
          <GroupHead label={g.label} ids={g.layers.map((l) => l.id)} />
          {g.layers.map((def) => (
            <LayerRow key={def.id} def={def} open={expanded.has(def.id)} onExpand={onExpand} />
          ))}
        </section>
      ))}
      <Blank />
    </>
  );
}

/** Dashed empty slots, so the panel has its shape before the catalog arrives. */
function PlaceholderRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="l sh-slot" aria-hidden="true">
          <span className="l-main">[ ] </span>
          <span className="l-right">--</span>
        </div>
      ))}
    </>
  );
}

const RULE = '='.repeat(120);

function GroupHead({ label, ids }: { label: string; ids: string[] }) {
  const on = useApp((s) => ids.filter((id) => s.visible.includes(id)).length);
  return (
    <h3 className="l sh-group">
      <span className="l-main">{label.toUpperCase()}</span>
      <span className="sh-fill" aria-hidden="true">
        {RULE}
      </span>
      <span className="l-right muted" aria-label={`${on} of ${ids.length} on`}>
        {on}/{ids.length}
      </span>
    </h3>
  );
}

function LayerRow({ def, open, onExpand }: { def: LayerDef; open: boolean; onExpand: (id: string, open: boolean) => void }) {
  const v = useLayerView(def.id);
  const health = useLayerHealth(def.id);
  const setLayerVisible = useApp((s) => s.setLayerVisible);
  const needsClock = v.visible && v.status === 'error';
  return (
    <div className="sh-layer" data-layer={def.id} data-state={v.visible ? v.status : 'off'}>
      <Check
        checked={v.visible}
        onChange={(on) => setLayerVisible(def.id, on)}
        label={
          <>
            <span aria-hidden="true">{def.short.toUpperCase()}</span>
            <span className="sr-only">{def.label}</span>
          </>
        }
        right={
          def.kind === 'raster' ? (
            <RasterRowRight def={def} open={open} onExpand={onExpand} />
          ) : (
            <RowRight def={def} open={open} onExpand={onExpand} health={health} />
          )
        }
      />
      {v.visible &&
        (def.kind === 'raster' ? (
          <RasterControls def={def} />
        ) : needsClock ? (
          <RowNotesTicking def={def} health={health} />
        ) : (
          <RowNotes def={def} health={health} now={0} />
        ))}
      {open && <Expanded def={def} />}
    </div>
  );
}

function ExpandButton({ def, open, onExpand }: { def: LayerDef; open: boolean; onExpand: (id: string, open: boolean) => void }) {
  return (
    <button
      type="button"
      className="t"
      aria-expanded={open}
      aria-controls={`sh-x-${def.id}`}
      aria-label={`${open ? 'Hide' : 'Show'} legend and filters for ${def.label}`}
      onClick={() => onExpand(def.id, !open)}
    >
      {open ? '[-]' : '[+]'}
    </button>
  );
}

const RASTER_DOT: Record<RasterStatus, { dot: FreshState; title: string }> = {
  off: { dot: 'off', title: 'Layer off' },
  loading: { dot: 'loading', title: 'Loading' },
  ok: { dot: 'ok', title: 'Frame fresh' },
  stale: { dot: 'stale', title: 'Frame stale' },
  empty: { dot: 'never', title: 'No recent frame' },
  error: { dot: 'degraded', title: 'Frame index unavailable' },
};

/** A raster row has no features: the dot follows the frame, the count column stays blank. */
function RasterRowRight({ def, open, onExpand }: { def: LayerDef; open: boolean; onExpand: (id: string, open: boolean) => void }) {
  const d = useApp((s) => s.data[def.id]);
  const visible = useApp((s) => s.visible.includes(def.id));
  const now = useNow();
  const st = RASTER_DOT[rasterStatus(d, def, visible, now)];
  return (
    <>
      <FreshDot state={st.dot} title={st.title} />
      <span className="sh-count muted" aria-label="Map tiles, no features">
        <Num value={null} width={6} />
      </span>
      <ExpandButton def={def} open={open} onExpand={onExpand} />
    </>
  );
}

function RowRight({
  def,
  open,
  onExpand,
  health,
}: {
  def: LayerDef;
  open: boolean;
  onExpand: (id: string, open: boolean) => void;
  health: ReturnType<typeof useLayerHealth>;
}) {
  const v = useLayerView(def.id);
  const rs = rowState(v, health, def, 0);
  return (
    <>
      <FreshDot state={rs.dot} title={rs.dotTitle} />
      <span className={v.visible ? 'sh-count' : 'sh-count muted'} aria-label={`${rs.count ?? 'no'} features`}>
        <Num value={rs.count} width={6} deal />
      </span>
      <ExpandButton def={def} open={open} onExpand={onExpand} />
    </>
  );
}

function RowNotesTicking({ def, health }: { def: LayerDef; health: ReturnType<typeof useLayerHealth> }) {
  const now = useNow();
  return <RowNotes def={def} health={health} now={now} />;
}

function RowNotes({ def, health, now }: { def: LayerDef; health: ReturnType<typeof useLayerHealth>; now: number }) {
  const v = useLayerView(def.id);
  const notes = rowState(v, health, def, now).notes;
  if (!notes.length) return null;
  return (
    <div className="sh-ind" role="status">
      {notes.map((n) => (
        <Note key={n.key} note={n} />
      ))}
    </div>
  );
}

function Note({ note }: { note: RowNote }) {
  if (note.tone === 'warn') {
    return (
      <Line>
        <Banner tone="warn">{note.text}</Banner>
      </Line>
    );
  }
  return (
    <Line muted>
      <span className={note.key === 'loading' ? 'sh-dots' : undefined}>{note.text}</span>
    </Line>
  );
}

// ---- Expanded block ------------------------------------------------------------------------

function Expanded({ def }: { def: LayerDef }) {
  const plan = useMemo(() => planLegend(def), [def]);
  const overrides = useApp((s) => s.filters[def.id]);
  const resetFilters = useApp((s) => s.resetFilters);
  return (
    <div className="sh-ind sh-x" id={`sh-x-${def.id}`}>
      <Line>{def.label.toUpperCase()}</Line>
      {plan.rest.length > 0 && <Legend title={def.legend_title} items={plan.rest} />}
      {def.filters.map((f) => (
        <FilterControl key={f.key} def={def} f={f} value={controlValue(f, overrides)} swatches={plan.onOptions} />
      ))}
      <Timing def={def} />
      <Line>
        {def.filters.length > 0 && (
          <TextButton disabled={!overrides} onClick={() => resetFilters(def.id)} ariaLabel={`Reset filters for ${def.label}`}>
            RESET
          </TextButton>
        )}
        {def.list && <ListButton def={def} />}
      </Line>
      <Blank />
    </div>
  );
}

function Legend({ title, items }: { title: string; items: LegendItem[] }) {
  return (
    <>
      <Line muted>{title.toUpperCase()}</Line>
      {items.map((it) => (
        <Line key={it.label}>
          <Swatch shape={it.shape} color={it.color} glyph={it.glyph} /> {it.label}
        </Line>
      ))}
    </>
  );
}

function FilterControl({
  def,
  f,
  value,
  swatches,
}: {
  def: LayerDef;
  f: FilterDef;
  value: FilterValue;
  swatches: Map<string, LegendItem>;
}) {
  const setFilter = useApp((s) => s.setFilter);
  const server = f.apply === 'server' ? <span className="muted"> (RELOADS)</span> : null;

  if (f.type === 'toggle') {
    return (
      <Check
        checked={value === true}
        onChange={(on) => setFilter(def.id, f.key, nextToggle(on))}
        label={
          <>
            {f.label}
            {server}
          </>
        }
      />
    );
  }

  if (f.type === 'select') {
    return (
      <div role="radiogroup" aria-label={f.label}>
        <Line muted>
          {f.label.toUpperCase()}
          {server}
        </Line>
        {(f.options ?? []).map((o) => (
          <Radio
            key={o.value}
            name={`sh-${def.id}-${f.key}`}
            checked={String(value) === o.value}
            onChange={(on) => on && setFilter(def.id, f.key, nextSelect(f, o.value))}
            label={o.label}
          />
        ))}
      </div>
    );
  }

  return <EnumControl def={def} f={f} value={value} swatches={swatches} server={server} />;
}

function EnumControl({
  def,
  f,
  value,
  swatches,
  server,
}: {
  def: LayerDef;
  f: FilterDef;
  value: FilterValue;
  swatches: Map<string, LegendItem>;
  server: ReactNode;
}) {
  const setFilter = useApp((s) => s.setFilter);
  const counts = useOptionCounts(def, f.apply === 'client' ? f.prop : undefined);
  const sel = enumSelected(value);
  const all = enumIsAll(f, value);
  return (
    <div role="group" aria-label={f.label}>
      <Line
        muted
        right={
          !all && (
            <TextButton onClick={() => setFilter(def.id, f.key, allEnum(f))} ariaLabel={`Select every ${f.label} option`}>
              ALL
            </TextButton>
          )
        }
      >
        {f.label.toUpperCase()}
        {server}
      </Line>
      {(f.options ?? []).map((o) => {
        const sw = swatches.get(`${f.key}:${o.value}`);
        return (
          <Check
            key={o.value}
            checked={sel.has(o.value)}
            onChange={(on) => setFilter(def.id, f.key, nextEnum(f, value, o.value, on))}
            label={
              <>
                {sw && <Swatch shape={sw.shape} color={sw.color} glyph={sw.glyph} />}
                {sw ? ' ' : ''}
                {o.label}
              </>
            }
            right={counts && <Num value={counts.get(o.value) ?? 0} width={6} />}
          />
        );
      })}
    </div>
  );
}

/** Features per option value, after the borough rule but before this layer's own filters. */
function useOptionCounts(def: LayerDef, prop: string | undefined): Map<string, number> | null {
  const raw = useApp((s) => s.data[def.id]?.features);
  const boroughs = useApp((s) => s.boroughs);
  const rev = useApp((s) => s.data[def.id]?.rev ?? 0);
  return useMemo(() => {
    if (!prop || !raw || rev === 0) return null;
    const scoped = applyClientFilters(raw, { ...def, filters: [] }, {}, def.borough_filter ? boroughs : []);
    return countBy(scoped, prop);
  }, [def, prop, raw, boroughs, rev]);
}

function Timing({ def }: { def: LayerDef }) {
  const v = useLayerView(def.id);
  const now = useNow();
  const m = v.meta;
  const next = v.visible && v.nextAt ? `, NEXT ${fmtCountdown(v.nextAt - now)}` : '';
  const span = m?.window ? (Date.parse(m.window.to) - Date.parse(m.window.from)) / 1000 : null;
  return (
    <>
      <Readout k="AS OF" v={m?.data_as_of ? fmtTime(m.data_as_of, 'datetime').toUpperCase() : '--'} />
      {span !== null && <Readout k="WINDOW" v={`${fmtDuration(span)} TO THE NEWEST RECORD`} />}
      <Readout k="FETCHED" v={v.fetchedAt ? fmtAgo(v.fetchedAt, now).toUpperCase() : '--'} />
      <Readout k="REFRESH" v={`${fmtPoll(def.poll_s)}${next}`} />
      {def.lag_note && <Line muted>{def.lag_note}</Line>}
      {m?.note && <Line muted>{m.note}</Line>}
      <Line muted>
        SOURCE:{' '}
        <a href={def.attribution.url} target="_blank" rel="noreferrer">
          {def.attribution.text}
        </a>
      </Line>
    </>
  );
}

/** [LIST n]: opens the drawer's list mode. n is the API's count of listed events. */
function ListButton({ def }: { def: LayerDef }) {
  const visible = useApp((s) => s.visible.includes(def.id));
  const rev = useApp((s) => s.data[def.id]?.rev ?? 0);
  const listing = useApp((s) => s.selection?.mode === 'list' && s.selection.layer === def.id);
  const select = useApp((s) => s.select);
  const [total, setTotal] = useState<{ rev: number; n: number } | null>(null);

  useEffect(() => {
    if (!visible || rev === 0) return;
    let live = true;
    api.events(def.id, { limit: 1 }).then(
      (p) => live && setTotal({ rev, n: p.total }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [def.id, visible, rev]);

  const label = total ? `LIST ${fmtInt(total.n)}` : 'LIST';
  return (
    <TextButton
      pressed={listing}
      disabled={!visible}
      onClick={() => select(listing ? null : { mode: 'list', layer: def.id })}
      ariaLabel={visible ? `List ${def.label}` : `Turn on ${def.label} to list it`}
    >
      {label}
    </TextButton>
  );
}
