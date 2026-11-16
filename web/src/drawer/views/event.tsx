// Event views (catalog `detail: event:<source>`): 311, collisions, NWS alerts, flood events.
import { fmtTime, useApp } from '../../core';
import type { EventDetail, FeatureProps } from '../../types';
import { Blank, Line, Readout } from '../../ui';
import { SeriesChart } from '../charts/SeriesChart';
import type { Point, Tick } from '../charts/path';
import { fixed, fmtDuration, fmtRange, num } from '../detail';
import { Loading, readableText, TextBlock, statusLabel } from './common';

export interface EventViewProps {
  source: string;
  id: string;
  props: Partial<FeatureProps> | undefined;
  detail: EventDetail | undefined;
}

const dt = (ts: string) => fmtTime(ts, 'datetime');
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const n = (v: unknown): number => num(v) ?? 0;

// ---- 311 ------------------------------------------------------------------------------------

function ComplaintView({ props, detail }: EventViewProps) {
  const p = detail?.props ?? {};
  const type = detail?.subtype ?? s(props?.type);
  const started = detail?.starts_at ?? s(props?.starts_at);
  return (
    <>
      {detail && <Line>{detail.title}</Line>}
      <Readout k="TYPE" v={type ?? '--'} r={s(props?.group)?.toUpperCase()} />
      {detail && <Readout k="DETAIL" v={s(p.descriptor) ?? '--'} />}
      <Readout k="STATUS" v={s(p.status)?.toUpperCase() ?? s(props?.status)?.toUpperCase() ?? '--'} />
      <Readout k="AGENCY" v={s(p.agency) ?? s(props?.agency) ?? '--'} r={s(p.incident_zip) ? `ZIP ${s(p.incident_zip)}` : undefined} />
      {started && <Readout k="OPENED" v={dt(started)} />}
      {detail?.ends_at && <Readout k="CLOSED" v={dt(detail.ends_at)} />}
      {!detail && <Loading />}
      {detail && <Blank />}
      <TextBlock label="RESOLUTION" text={p.resolution} />
    </>
  );
}

// ---- Collision ------------------------------------------------------------------------------

function CollisionView({ props, detail }: EventViewProps) {
  const p = detail?.props ?? {};
  const started = detail?.starts_at ?? s(props?.starts_at);
  const street = [s(p.on_street_name) ?? s(props?.street), s(p.cross_street_name)].filter(Boolean).join(' AT ');
  const vehicles = Array.isArray(p.vehicle_types) ? (p.vehicle_types as unknown[]).filter((v) => typeof v === 'string') : [];
  const injured = detail ? n(p.persons_injured) : n(props?.injured);
  const killed = detail ? n(p.persons_killed) : n(props?.killed);
  const split = (kind: string) =>
    `${n(p[`pedestrians_${kind}`])} PED · ${n(p[`cyclist_${kind}`])} CYC · ${n(p[`motorist_${kind}`])} MOT`;
  return (
    <>
      {started && <Readout k="WHEN" v={dt(started)} />}
      <Readout k="WHERE" v={street || s(p.off_street_name) || '--'} />
      <Readout k="INJURED" v={String(injured)} r={detail ? <span className="muted">{split('injured')}</span> : undefined} />
      <Readout k="KILLED" v={String(killed)} r={detail && killed > 0 ? <span className="muted">{split('killed')}</span> : undefined} />
      {!detail && <Loading />}
      {detail && <Readout k="VEHICLES" v={vehicles.length ? vehicles.join(', ') : '--'} />}
      {detail?.subtype && <Readout k="FACTOR" v={detail.subtype} />}
    </>
  );
}

// ---- NWS alert ------------------------------------------------------------------------------

function NwsView({ props, detail }: EventViewProps) {
  const p = detail?.props ?? {};
  const start = detail?.starts_at ?? s(props?.starts_at);
  const end = detail ? detail.ends_at : (s(props?.ends_at) ?? null);
  return (
    <>
      <Readout k="EVENT" v={s(props?.event) ?? detail?.subtype ?? '--'} r={detail ? statusLabel(detail) : s(props?.status)?.toUpperCase()} />
      <Readout k="SEVERITY" v={s(p.severity)?.toUpperCase() ?? '--'} r={s(p.urgency)?.toUpperCase()} />
      {s(p.certainty) && <Readout k="CERTAINTY" v={s(p.certainty)!.toUpperCase()} />}
      {start && <Line>{fmtRange(start, end, dt)}</Line>}
      {s(p.sender_name) && <Readout k="ISSUED BY" v={s(p.sender_name)} />}
      {!detail && <Loading />}
      <Blank />
      {detail?.title && <TextBlock label="HEADLINE" text={detail.title} />}
      <TextBlock label="AREA" text={p.areaDesc ?? props?.area} />
      <TextBlock label="DESCRIPTION" text={p.description} />
      <TextBlock label="INSTRUCTION" text={p.instruction} />
    </>
  );
}

// ---- Notify NYC alert (ADR-015) ---------------------------------------------------------------

function CapView({ props, detail }: EventViewProps) {
  const p = detail?.props ?? {};
  const start = detail?.starts_at ?? s(props?.starts_at);
  const end = detail ? detail.ends_at : (s(props?.ends_at) ?? null);
  const msg = s(p.msg_type) ?? s(props?.msg_type);
  return (
    <>
      <Readout k="EVENT" v={s(props?.event) ?? detail?.subtype ?? '--'} r={detail ? statusLabel(detail) : s(props?.status)?.toUpperCase()} />
      {(s(p.severity) || s(p.urgency)) && <Readout k="SEVERITY" v={s(p.severity)?.toUpperCase() ?? '--'} r={s(p.urgency)?.toUpperCase()} />}
      {start && <Line>{fmtRange(start, end, dt)}</Line>}
      {p.citywide === true && <Line muted>CITYWIDE: NOT DRAWN ON THE MAP</Line>}
      {msg === 'Update' && <Line muted>UPDATES AN EARLIER ALERT</Line>}
      {msg === 'Cancel' && <Line muted>CANCELS AN EARLIER ALERT</Line>}
      <Readout k="ISSUED BY" v="NYC EMERGENCY MANAGEMENT" />
      {!detail && <Loading />}
      <Blank />
      <TextBlock label="AREA" text={p.area_desc ?? props?.area} />
      <TextBlock label="DESCRIPTION" text={typeof p.description === 'string' ? readableText(p.description) : p.description} />
    </>
  );
}

// ---- Flood event ----------------------------------------------------------------------------

/** Depth profile as chart points: [epoch s, inches]. Mismatched or junk arrays give []. */
export function profilePoints(startIso: string, secs: unknown, depth: unknown): Point[] {
  const t0 = Date.parse(startIso) / 1000;
  if (!Number.isFinite(t0) || !Array.isArray(secs) || !Array.isArray(depth)) return [];
  const out: Point[] = [];
  const len = Math.min(secs.length, depth.length);
  for (let i = 0; i < len; i++) {
    const x = secs[i];
    const y = depth[i];
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) out.push([t0 + x, y]);
  }
  return out;
}

function minuteTicks(from: number, to: number): Tick[] {
  const mins = (to - from) / 60;
  if (!(mins > 0)) return [];
  const every = mins > 360 ? 120 : mins > 120 ? 60 : mins > 40 ? 15 : 5;
  const ticks: Tick[] = [];
  for (let m = 0; m <= mins; m += every) ticks.push({ at: from + m * 60, label: m === 0 ? '0' : `${m} MIN` });
  return ticks;
}

function FloodEventView({ props, detail }: EventViewProps) {
  const select = useApp((st) => st.select);
  const sensorsOn = useApp((st) => st.visible.includes('flood_sensors'));
  const p = detail?.props ?? {};
  const sensorId = s(props?.sensor_id) ?? detail?.entity_refs.find((r) => r.startsWith('flood_sensor:'))?.slice(13) ?? null;
  const sensorName = s(props?.name) ?? detail?.entities.find((e) => e.kind === 'flood_sensor')?.name ?? sensorId;
  const start = detail?.starts_at ?? s(props?.starts_at);
  const end = detail ? detail.ends_at : (s(props?.ends_at) ?? null);
  const peak = num(p.max_depth_inches) ?? num(props?.max_depth_in);
  const duration = num(p.duration_mins) ?? num(props?.duration_min);
  const pts = start && detail ? profilePoints(start, p.profile_time_secs, p.profile_depth_inches) : [];
  const from = pts.length ? pts[0][0] : 0;
  const to = pts.length ? pts[pts.length - 1][0] : 1;
  return (
    <>
      <Readout
        k="SENSOR"
        v={
          sensorsOn && sensorId ? (
            <button
              type="button"
              className="t drw-link"
              onClick={() => select({ mode: 'feature', layer: 'flood_sensors', id: sensorId })}
              aria-label={`Open sensor ${sensorName ?? sensorId}`}
            >
              {sensorName}
            </button>
          ) : (
            (sensorName ?? '--')
          )
        }
      />
      <Readout k="PEAK DEPTH" v={`${fixed(peak, 2)} IN`} />
      {start && <Readout k="STARTED" v={dt(start)} />}
      <Readout k="ENDED" v={end ? dt(end) : 'STILL WET OR NOT REPORTED'} />
      <Readout k="DURATION" v={fmtDuration(duration)} r={num(p.onset_mins) != null ? `PEAK AFTER ${fmtDuration(num(p.onset_mins))}` : undefined} />
      {num(p.drain_mins) != null && <Readout k="DRAIN TIME" v={fmtDuration(num(p.drain_mins))} />}
      <Blank />
      <Line right={<span className="muted">INCHES OVER TIME</span>}>DEPTH PROFILE</Line>
      {!detail ? (
        <Loading>LOADING PROFILE…</Loading>
      ) : pts.length === 0 ? (
        <Line muted>NO DEPTH PROFILE IN THIS RECORD</Line>
      ) : (
        <>
          <SeriesChart
            series={[{ key: 'depth', label: 'DEPTH', points: pts }]}
            from={from}
            to={to}
            lines={8}
            zero
            minSpan={2}
            fmtV={(_k, v) => `${v.toFixed(2)} IN`}
            ticks={minuteTicks(from, to)}
            label={`Flood depth profile, peak ${fixed(peak, 2)} inches over ${fmtDuration(duration)}`}
          />
          <Line muted>Minutes from the start of the flood.</Line>
        </>
      )}
    </>
  );
}

// ---- Dispatch -------------------------------------------------------------------------------

function GenericEvent({ detail }: EventViewProps) {
  if (!detail) return <Loading />;
  return (
    <>
      <Line>{detail.title}</Line>
      <Line muted>{fmtRange(detail.starts_at, detail.ends_at, dt)}</Line>
      <TextBlock label="DESCRIPTION" text={detail.props.description} />
    </>
  );
}

const VIEWS: Record<string, (p: EventViewProps) => React.JSX.Element> = {
  nyc_311: ComplaintView,
  nyc_collisions: CollisionView,
  nws_alerts: NwsView,
  notify_nyc: CapView,
  floodnet_events: FloodEventView,
};

export function EventView(p: EventViewProps) {
  const View = VIEWS[p.source] ?? GenericEvent;
  return <View {...p} />;
}
