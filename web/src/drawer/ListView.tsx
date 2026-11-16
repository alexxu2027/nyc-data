// List mode (`{mode: 'list', layer}`) for `list: true` layers, from /api/events. It includes the
// events the map cannot place (line-wide subway alerts). Picking a placed one selects it on the
// map and flies there.
import { useCallback, useState } from 'react';
import { api, fmtInt, useApp } from '../core';
import type { EventSummary, EventsPage, LayerDef, LayerFeature } from '../types';
import { Blank, Line, TextButton } from '../ui';
import { useAsync } from './hooks';
import { ErrorState, EventItem, Loading } from './views/common';

export const PAGE = 100;
type Status = 'active' | 'upcoming' | 'all';

/** The layer feature an event selects: its own id for event layers, else its first station on the map. */
export function selectionIdFor(def: LayerDef, ev: EventSummary, features: LayerFeature[]): string | null {
  if (def.detail.type !== 'entity') return ev.id;
  if (ev.stations.length === 0) return null;
  const ids = new Set(features.map((f) => f.properties.id));
  return (ev.stations.find((s) => ids.has(s.id)) ?? ev.stations[0]).id;
}

function statusLabels(def: LayerDef): Record<Status, string> {
  const opts = def.filters.find((f) => f.key === 'status')?.options ?? [];
  const label = (vals: string[], fb: string) => opts.find((o) => vals.includes(o.value))?.label.toUpperCase() ?? fb;
  return { active: label(['active', 'current'], 'IN EFFECT'), upcoming: label(['upcoming'], 'UPCOMING'), all: 'ALL' };
}

function useEventsPage(layer: string, status: Status, offset: number, rev: number) {
  const load = useCallback(() => api.events(layer, { status, limit: PAGE, offset }), [layer, status, offset]);
  return useAsync<EventsPage>(`${layer}\u0000${status}\u0000${offset}`, rev, load);
}

function Items({ def, page, onPicked }: { def: LayerDef; page: EventsPage; onPicked: () => void }) {
  const select = useApp((s) => s.select);
  const flyTo = useApp((s) => s.flyTo);
  const features = useApp((s) => s.data[def.id]?.features);
  return (
    <>
      {page.events.map((ev) => {
        const located = ev.lat != null && ev.lon != null;
        const id = located ? selectionIdFor(def, ev, features ?? []) : null;
        const locate =
          located && id !== null
            ? () => {
                onPicked();
                select({ mode: 'feature', layer: def.id, id });
                flyTo({ lng: ev.lon!, lat: ev.lat!, zoom: def.kind === 'polygon' ? 10 : 14.5 });
              }
            : undefined;
        return (
          <div key={`${ev.source}:${ev.id}`}>
            <EventItem ev={ev} onLocate={locate} />
            <Blank />
          </div>
        );
      })}
    </>
  );
}

function MorePage({ def, status, offset, rev, onPicked, onMore, isLast }: {
  def: LayerDef; status: Status; offset: number; rev: number; onPicked: () => void; onMore: () => void; isLast: boolean;
}) {
  const res = useEventsPage(def.id, status, offset, rev);
  if (res.loading) return <Loading>LOADING MORE…</Loading>;
  if (!res.data) return <ErrorState error={res.error} what="PAGE" />;
  const page = res.data;
  return (
    <>
      <Items def={def} page={page} onPicked={onPicked} />
      {isLast && offset + PAGE < page.total && <MoreButton shown={offset + page.events.length} total={page.total} onMore={onMore} />}
    </>
  );
}

function MoreButton({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  return (
    <Line center>
      <TextButton onClick={onMore} ariaLabel="Load the next page of events">
        {`MORE (${fmtInt(total - shown)} LEFT)`}
      </TextButton>
    </Line>
  );
}

export function ListView({ def, onPicked }: { def: LayerDef; onPicked: () => void }) {
  const [status, setStatus] = useState<Status>('active');
  const [pages, setPages] = useState(1);
  const [retry, setRetry] = useState(0);
  const rev = useApp((s) => s.data[def.id]?.rev ?? 0) + retry * 1e6;
  const first = useEventsPage(def.id, status, 0, rev);
  const labels = statusLabels(def);
  const choose = (st: Status) => {
    setStatus(st);
    setPages(1);
  };
  const page = first.data;
  const unplaced = page ? page.events.filter((e) => e.lat == null || e.lon == null).length : 0;
  return (
    <>
      <Line>
        {(['active', 'upcoming', 'all'] as const).map((st) => (
          <TextButton key={st} pressed={status === st} onClick={() => choose(st)} ariaLabel={`Show ${labels[st].toLowerCase()}`}>
            {labels[st]}
          </TextButton>
        ))}
      </Line>
      {first.loading ? (
        <Loading>LOADING LIST…</Loading>
      ) : !page ? (
        <ErrorState error={first.error} what="LIST" onRetry={() => setRetry((r) => r + 1)} />
      ) : page.total === 0 ? (
        <>
          <Blank />
          <Line center>{status === 'active' && def.empty_text ? def.empty_text : 'NOTHING TO LIST'}</Line>
        </>
      ) : (
        <>
          <Line right={unplaced > 0 ? <span className="muted">{unplaced} NOT ON MAP</span> : undefined}>
            {fmtInt(page.total)} {page.total === 1 ? 'ITEM' : 'ITEMS'}
          </Line>
          <Line muted>Click a title to find it on the map.</Line>
          <Blank />
          <Items def={def} page={page} onPicked={onPicked} />
          {pages === 1 && PAGE < page.total && (
            <MoreButton shown={page.events.length} total={page.total} onMore={() => setPages(2)} />
          )}
          {Array.from({ length: pages - 1 }, (_, i) => (
            <MorePage
              key={i}
              def={def}
              status={status}
              offset={(i + 1) * PAGE}
              rev={rev}
              onPicked={onPicked}
              isLast={i === pages - 2}
              onMore={() => setPages((p) => p + 1)}
            />
          ))}
        </>
      )}
    </>
  );
}
