// A clicked subway train, in plain words (2026-11-17): which train, where it is, its next stop
// and roughly when, how fresh the MTA's report is, and today's service changes on that route.
// Everything except the service changes comes from the train's own map feature (the drawer
// re-renders on each 30 s poll and on its clock tick), so there is no detail endpoint.
import { useCallback } from 'react';
import { api, fmtAgo } from '../../core';
import { progressAt } from '../../map/layers/trains';
import type { EventsPage, FeatureProps, LayerFeature } from '../../types';
import { Blank, Line, Readout } from '../../ui';
import { trainName } from '../detail';
import { useAsync, useClock } from '../hooks';
import { ErrorState, EventItem, Loading, Text } from './common';

/** The trunk line each route group runs on, as New Yorkers and the MTA's maps name it. */
export const TRUNK: Record<string, string> = {
  '123': 'Broadway–7 Av line',
  '456': 'Lexington Av line',
  '7': 'Flushing line',
  ACE: '8 Av line',
  BDFM: '6 Av line',
  G: 'Crosstown line',
  JZ: 'Nassau St line',
  L: '14 St–Canarsie line',
  NQRW: 'Broadway line',
  S: 'Shuttle',
  SIR: 'Staten Island Railway',
};

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Black or white text on the route's colour (the N Q R W yellow needs black). */
function bulletInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

export interface TrainWhere {
  /** "Between Ditmas Av and 18 Av", "At 18 Av", "Waiting to leave 242 St". */
  now: string;
  /** "About 1 min", "Arriving now", or null when it's at the stop. */
  due: string | null;
}

/** Where the train is at `nowMs`, in words, from its run's t0 / t1 (the map's own estimate). */
export function trainWhere(p: Partial<FeatureProps>, nowMs: number): TrainWhere {
  const next = s(p.next_name) ?? 'its next stop';
  const prev = s(p.prev_name);
  if (p.at_stop === true) return { now: prev ? `At ${next}` : `Waiting to leave ${next}`, due: null };
  const progress = progressAt({ type: 'Feature', geometry: null, properties: p } as unknown as LayerFeature, nowMs);
  const t1 = typeof p.t1 === 'string' ? Date.parse(p.t1) : NaN;
  const left = Number.isFinite(t1) ? Math.round((t1 - nowMs) / 60_000) : null;
  if (progress >= 1) return { now: `At or arriving at ${next}`, due: null };
  const due = left === null ? null : left <= 0 ? 'Arriving now' : `About ${left} min`;
  return { now: prev ? `Between ${prev} and ${next}` : `Heading to ${next}`, due };
}

export function TrainView({ props }: { props: Partial<FeatureProps> | undefined }) {
  const now = useClock();
  const route = s(props?.route);
  const load = useCallback((): Promise<EventsPage> => api.events('subway_alerts', { status: 'active', limit: 200 }), []);
  // Service changes refresh with the minute, not every clock tick.
  const alerts = useAsync<EventsPage>(route ? 'train-alerts' : null, Math.floor(now / 60_000), route ? load : null);
  if (!props || !route) return <Line muted>NO FURTHER DETAIL FOR THIS TRAIN</Line>;

  const color = s(props.color) ?? '#7c858c';
  const trunk = TRUNK[s(props.line) ?? ''] ?? null;
  const where = trainWhere(props, now);
  const run = typeof props.run_s === 'number' && props.run_s > 0 ? Math.max(1, Math.round(props.run_s / 60)) : null;
  const seen = s(props.seen_at);
  const mine = (alerts.data?.events ?? []).filter((ev) => ev.routes.includes(route));

  return (
    <>
      <Readout
        k="LINE"
        v={
          <>
            <span className="drw-bullet" style={{ background: color, color: bulletInk(color) }}>
              {route}
            </span>{' '}
            {trainName(route)}
          </>
        }
        r={trunk ?? undefined}
      />
      <Readout k="GOING TO" v={s(props.headsign) ?? '--'} />
      <Readout k="NOW" v={where.now} />
      {props.at_stop !== true && <Readout k="NEXT STOP" v={s(props.next_name) ?? '--'} r={where.due ?? undefined} />}
      <Readout k="MTA UPDATE" v={seen ? fmtAgo(seen, now) : '--'} />
      <Blank />
      <Text muted>
        The MTA reports which stop each train is heading to. The map moves it along the track by the schedule
        {run ? ` (${run} min between these stops)` : ''}, so its spot between stations is an estimate.
      </Text>
      <Blank />
      <Line>SERVICE CHANGES ON THE {route} NOW</Line>
      {alerts.error && !alerts.data ? (
        <ErrorState error={alerts.error} what="SERVICE CHANGES" />
      ) : !alerts.data ? (
        <Loading>LOADING SERVICE CHANGES…</Loading>
      ) : mine.length === 0 ? (
        <Line muted>None reported right now.</Line>
      ) : (
        mine.slice(0, 5).map((ev) => <EventItem key={ev.id} ev={ev} collapsible />)
      )}
      {mine.length > 5 && <Line muted>+ {mine.length - 5} more in the Subway alerts list</Line>}
    </>
  );
}
