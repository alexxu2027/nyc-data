// The detail drawer (U6). Content only: the Shell positions it (plan §7.2). It reads `selection`
// from the store and shows either one feature (an instant header from the feature, then the
// detail endpoint the catalog names) or a list of a `list: true` layer's events.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtAgo, fmtTime, useApp } from '../core';
import type { EntityDetail, EventDetail, LayerDef, LayerFeature } from '../types';
import { Blank, Line, Panel, Readout, TextButton, usePrintRows } from '../ui';
import { BOROUGH_NAMES, asOfTime, featureTitle } from './detail';
import { useAsync, useClock } from './hooks';
import { ListView } from './ListView';
import { ErrorState } from './views/common';
import { EntityView } from './views/entity';
import { EventView } from './views/event';
import { BusView } from './views/bus';
import { TrainView } from './views/train';
import './drawer.css';

const NO_FEATURES: LayerFeature[] = [];

export function Drawer() {
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const def = useApp((s) => (s.selection ? s.catalog?.layers.find((l) => l.id === s.selection?.layer) : undefined));
  // The list a feature was opened from, so [< LIST] can go back to it.
  const [fromList, setFromList] = useState<string | null>(null);

  const open = selection !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, select]);

  if (!selection) return null;
  const close = (
    <div className="drawer-close">
      <TextButton onClick={() => select(null)} ariaLabel="Close the detail drawer (Esc)">
        CLOSE
      </TextButton>
    </div>
  );
  if (!def) {
    return (
      <div className="drawer" aria-label="Detail">
        <Panel numbered title="DETAIL">
          <Line muted>LOADING THE LAYER CATALOG…</Line>
        </Panel>
        {close}
      </div>
    );
  }
  const list = selection.mode === 'list';
  const listLayer = def.id;
  return (
    <div className="drawer" role="region" aria-label={`${def.label} ${list ? 'list' : 'detail'}`}>
      <Panel
        numbered
        title={list ? `${def.short} LIST` : def.short}
        footer={<Footer def={def} />}
      >
        {list ? (
          <ListView key={def.id} def={def} onPicked={() => setFromList(listLayer)} />
        ) : (
          <FeatureView
            key={`${def.id}:${selection.id}`}
            def={def}
            id={selection.id}
            back={fromList === def.id && def.list ? () => select({ mode: 'list', layer: def.id }) : undefined}
          />
        )}
      </Panel>
      {close}
    </div>
  );
}

function Footer({ def }: { def: LayerDef }) {
  return (
    <Line muted title={def.attribution.text}>
      SOURCE:{' '}
      <a href={def.attribution.url} target="_blank" rel="noreferrer">
        {def.attribution.text}
      </a>
    </Line>
  );
}

function FeatureView({ def, id, back }: { def: LayerDef; id: string; back?: () => void }) {
  const layer = useApp((s) => s.data[def.id]);
  const features = layer?.features ?? NO_FEATURES;
  const feature = useMemo(() => features.find((f) => f.properties.id === id), [features, id]);
  const [retry, setRetry] = useState(0);
  const rev = (layer?.rev ?? 0) + retry * 1e6;
  const now = useClock();
  // A newly opened detail prints its rows top to bottom (this view remounts per selection).
  const printRef = useRef<HTMLDivElement>(null);
  usePrintRows(printRef);

  const detailRef = def.detail;
  const kind = detailRef.type === 'entity' ? detailRef.kind : null;
  const source = detailRef.type === 'event' ? detailRef.source : null;
  const load = useCallback((): Promise<EntityDetail | EventDetail> => {
    if (kind) return api.entity(kind, id);
    return api.event(source!, id);
  }, [kind, source, id]);
  const res = useAsync<EntityDetail | EventDetail>(kind || source ? `${kind ?? source}\u0000${id}` : null, rev, kind || source ? load : null);

  const props = feature?.properties;
  const entity = kind ? (res.data as EntityDetail | undefined) : undefined;
  const event = source ? (res.data as EventDetail | undefined) : undefined;
  const title = featureTitle(props, entity?.name ?? event?.title ?? id);
  const borough = props?.borough ?? res.data?.borough ?? null;
  const asOf = source ? (layer?.meta?.data_as_of ?? layer?.meta?.updated_at ?? null) : asOfTime(props, entity, layer?.meta, now);

  return (
    <div ref={printRef} className="drw-print">
      {back && (
        <Line>
          <TextButton onClick={back} ariaLabel={`Back to the ${def.label} list`}>
            &lt; LIST
          </TextButton>
        </Line>
      )}
      <Line>
        <span className="drw-title">{title}</span>
      </Line>
      <Readout k="LAYER" v={def.label} r={borough ? (BOROUGH_NAMES[borough] ?? borough).toUpperCase() : undefined} />
      {/* A camera's FRAME row says how fresh it is; the list's fetch time here read as "7 H AGO"
          next to a 2 s old frame (UX review B9). */}
      {kind !== 'camera' && (
        <Readout
          k="AS OF"
          v={asOf ? fmtTime(asOf, 'datetime') : '--'}
          r={asOf ? <span className="muted">{fmtAgo(asOf, now).toUpperCase()}</span> : undefined}
        />
      )}
      {def.lag_note && <Line muted>{def.lag_note}.</Line>}
      {!feature && layer?.status === 'ready' && (
        <Line muted>Not in the current map data (filtered out or gone).</Line>
      )}
      <Blank />
      {kind && (!(res.error && !res.data) || (kind === 'camera' && props)) ? (
        // One stable position, so a failed fetch doesn't remount (and restart) the camera frame.
        <EntityView key="entity" kind={kind} id={id} props={props} detail={entity} rev={rev} />
      ) : null}
      {res.error && !res.data ? (
        <ErrorState error={res.error} onRetry={() => setRetry((r) => r + 1)} />
      ) : kind ? null : source ? (
        <EventView source={source} id={id} props={props} detail={event} />
      ) : def.id === 'subway_trains' ? (
        <TrainView props={props} />
      ) : def.id === 'buses' ? (
        <BusView props={props} />
      ) : (
        <PropsTable props={props} />
      )}
    </div>
  );
}

/** Layers without a detail endpoint (borough outlines): the feature's own properties. */
function PropsTable({ props }: { props: Record<string, unknown> | undefined }) {
  if (!props) return <Line muted>NO FURTHER DETAIL FOR THIS LAYER</Line>;
  return (
    <>
      {Object.entries(props)
        .filter(([k, v]) => k !== 'id' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
        .map(([k, v]) => (
          <Readout key={k} k={k.replace(/_/g, ' ')} v={String(v)} />
        ))}
    </>
  );
}
