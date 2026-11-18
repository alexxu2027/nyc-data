// Building blocks shared by the per-kind views: honest states, text paragraphs, event items and
// the series block (a SeriesChart plus its ledger).
import { useCallback, useState, type ReactNode } from 'react';
import { api, fmtTime } from '../../core';
import type { EventSummary, SeriesSpec } from '../../types';
import { Banner, Line, Readout, TextButton } from '../../ui';
import { SeriesChart, type ChartSeries } from '../charts/SeriesChart';
import { clip, holdTo, hourTicks, type Point } from '../charts/path';
import { fmtRange, isTrimmed } from '../detail';
import { errorText, useAsync } from '../hooks';

const dt = (ts: string) => fmtTime(ts, 'datetime');

/** MTA text names its inline icons in brackets; say what they mean (UX review B13). */
export function readableText(s: string): string {
  return s
    .replace(/\[shuttle bus icon\]/gi, '[BUS]')
    .replace(/\[accessibility icon\]/gi, '[ACCESSIBLE]')
    .replace(/\[([a-z ]+) icon\]/gi, (_, w: string) => `[${w.trim().toUpperCase()}]`);
}

export function Loading({ children = 'LOADING DETAIL…' }: { children?: ReactNode }) {
  return (
    <Line muted>
      <span className="type-in">{children}</span>
    </Line>
  );
}

export function ErrorState({ error, onRetry, what = 'DETAIL' }: { error: Error | null; onRetry?: () => void; what?: string }) {
  return (
    <>
      <Line right={onRetry ? <TextButton onClick={onRetry} ariaLabel={`Retry loading the ${what.toLowerCase()}`}>RETRY</TextButton> : undefined}>
        <Banner tone="warn">{what} UNAVAILABLE</Banner>
      </Line>
      <Line muted>{errorText(error)}</Line>
    </>
  );
}

/** A paragraph of source text on the grid (keeps the feed's line breaks). */
export function Text({ children, muted, indent }: { children: ReactNode; muted?: boolean; indent?: boolean }) {
  const cls = ['l', 'drw-text', muted ? 'muted' : '', indent ? 'indent' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className="l-main">{children}</span>
    </div>
  );
}

/** A labelled block of text: "INSTRUCTION" then the paragraph. Nothing when empty. */
export function TextBlock({ label, text }: { label: string; text: unknown }) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  return (
    <>
      <Line muted>{label}</Line>
      <Text indent>{text.trim()}</Text>
    </>
  );
}

const STATUS: Record<string, Record<EventSummary['status'], string>> = {
  elevator_outage: { active: 'OUT NOW', upcoming: 'PLANNED', ended: 'BACK IN SERVICE' },
  default: { active: 'IN EFFECT', upcoming: 'UPCOMING', ended: 'ENDED' },
};

export function statusLabel(ev: Pick<EventSummary, 'category' | 'status'>): string {
  return (STATUS[ev.category] ?? STATUS.default)[ev.status];
}

/** The event's description; a trimmed summary offers the full text from the event endpoint. */
function Description({ ev }: { ev: EventSummary }) {
  const [full, setFull] = useState(false);
  const text = typeof ev.props.description === 'string' ? ev.props.description : null;
  const key = full ? `${ev.source}\u0000${ev.id}` : null;
  const load = useCallback(() => api.event(ev.source, ev.id), [ev.source, ev.id]);
  const res = useAsync(key, 0, full ? load : null);
  if (!text) return null;
  const fullText = typeof res.data?.props.description === 'string' ? res.data.props.description : null;
  return (
    <>
      <Text indent>{readableText((full && fullText) || text)}</Text>
      {isTrimmed(text) && (
        <Line indent muted>
          {full && res.loading ? (
            'LOADING FULL TEXT…'
          ) : full && res.error ? (
            errorText(res.error)
          ) : (
            <TextButton onClick={() => setFull(!full)} ariaLabel={full ? 'Show the short text' : 'Show the full text'}>
              {full ? 'SHORT TEXT' : 'FULL TEXT'}
            </TextButton>
          )}
        </Line>
      )}
    </>
  );
}

export interface EventItemProps {
  ev: EventSummary;
  /** Makes the title select the event on the map. */
  onLocate?: () => void;
  /** Show the stations line (lists); off inside a station's own view. */
  stations?: boolean;
  /** Show description and reason (default true). */
  text?: boolean;
  /** Lists: the text starts folded behind [MORE] so the list can be scanned (UX review B13). */
  collapsible?: boolean;
}

/** One alert, outage or flood in a list: title, status and times, then its text. */
export function EventItem({ ev, onLocate, stations = true, text = true, collapsible = false }: EventItemProps) {
  const [open, setOpen] = useState(!collapsible);
  const located = ev.lat != null && ev.lon != null;
  const hasText = Boolean(ev.props.reason || ev.props.est_return || ev.props.description);
  const reason = typeof ev.props.reason === 'string' ? ev.props.reason : null;
  const est = typeof ev.props.est_return === 'string' ? ev.props.est_return : null;
  return (
    <div className="drw-item" data-status={ev.status}>
      <Line onClick={onLocate} title={onLocate ? 'Show on the map' : undefined}>
        <span className="drw-st">{statusLabel(ev)}</span> {ev.title}
      </Line>
      <Line indent muted>
        {fmtRange(ev.starts_at, ev.ends_at, dt)}
      </Line>
      {(ev.subtype || ev.routes.length > 0) && (
        <Line indent muted>
          {ev.routes.length > 0 && <span className="drw-routes">{ev.routes.map((r) => `[${r}]`).join(' ')} </span>}
          {ev.subtype?.toUpperCase()}
        </Line>
      )}
      {stations && ev.stations.length > 0 && (
        <Line indent muted>
          AT {ev.stations.map((s) => s.name).join(', ')}
        </Line>
      )}
      {stations && !located && (
        <Line indent muted>
          LINE-WIDE, NOT ON THE MAP
        </Line>
      )}
      {text && open && reason && <Readout k="REASON" v={reason} />}
      {text && open && est && <Readout k="BACK BY" v={dt(est)} />}
      {text && open && <Description ev={ev} />}
      {text && collapsible && hasText && (
        <Line indent muted>
          <TextButton onClick={() => setOpen(!open)} ariaLabel={open ? `Hide the text of ${ev.title}` : `Show the text of ${ev.title}`}>
            {open ? 'LESS' : 'MORE'}
          </TextButton>
        </Line>
      )}
    </div>
  );
}

// ---- Series ---------------------------------------------------------------------------------

interface MetricLook {
  label: string;
  /** For the chart's hover readout when space is short. */
  short?: string;
  style?: ChartSeries['style'];
  unit?: string;
  map?: (v: number) => number;
  digits?: number;
}

const METRICS: Record<string, MetricLook> = {
  bikes_available: { label: 'BIKES', unit: '', digits: 0 },
  ebikes_available: { label: 'E-BIKES', style: 'dot', unit: '', digits: 0 },
  docks_available: { label: 'DOCKS', style: 'dash', unit: '', digits: 0 },
  water_level_ft: { label: 'OBSERVED', short: 'OBS', unit: 'FT', digits: 2 },
  predicted_ft: { label: 'PREDICTED', short: 'PRED', style: 'dash', unit: 'FT', digits: 2 },
  depth_in: { label: 'DEPTH', unit: 'IN', digits: 1 }, // FloodNet: read "DEPTH_IN 0.0 IN" before
  speed_mph: { label: 'SPEED', unit: 'MPH', digits: 1 },
  temp_c: { label: 'TEMP', unit: '°F', map: (c) => (c * 9) / 5 + 32, digits: 1 },
  wind_kmh: { label: 'WIND', unit: 'MPH', map: (k) => k / 1.609344, digits: 1 },
};

interface KindLook {
  step?: boolean;
  gap?: number;
  zero?: boolean;
  minSpan?: number;
}

const KINDS: Record<string, KindLook> = {
  bike_station: { step: true, zero: true, minSpan: 4 },
  tide_gauge: { gap: 1800, minSpan: 1 },
  road_segment: { gap: 1800, zero: true, minSpan: 10 },
  weather_point: { gap: 7200, minSpan: 4 },
};

const GLYPH: Record<NonNullable<ChartSeries['style']>, string> = { solid: '──', dash: '╌╌', dot: '··' };

/** Value at or before x (the reading in effect then). */
export function valueAt(points: Point[], x: number): number | null {
  let v: number | null = null;
  for (const [px, py] of points) {
    if (px > x) break;
    v = py;
  }
  return v;
}

function rangeLabel(spec: SeriesSpec): string {
  return spec.ahead > 0 ? `−${spec.hours} H TO +${spec.ahead} H` : `LAST ${spec.hours} H`;
}

/** One series descriptor from EntityDetail: fetched, drawn, and read out as a ledger. */
export function SeriesBlock({ kind, id, spec, rev }: { kind: string; id: string; spec: SeriesSpec; rev: number }) {
  const metrics = spec.metrics.join(',');
  const { hours, ahead } = spec;
  const load = useCallback(() => api.series(kind, id, metrics.split(','), hours, ahead), [kind, id, metrics, hours, ahead]);
  const res = useAsync(`${kind}\u0000${id}\u0000${metrics}\u0000${hours}\u0000${ahead}`, rev, load);
  const look = KINDS[kind] ?? {};
  const head = (
    <Line right={<span className="muted">{rangeLabel(spec)}</span>}>{spec.label.toUpperCase()}</Line>
  );
  if (res.loading) {
    return (
      <>
        {head}
        <Loading>LOADING READINGS…</Loading>
      </>
    );
  }
  if (!res.data) {
    return (
      <>
        {head}
        <ErrorState error={res.error} what="READINGS" />
      </>
    );
  }
  const from = Date.parse(res.data.from) / 1000;
  const to = Date.parse(res.data.to) / 1000;
  const now = Date.parse(res.data.now) / 1000;
  const series: Array<ChartSeries & { look: MetricLook }> = res.data.series.map((s) => {
    const m = METRICS[s.metric] ?? { label: s.metric.toUpperCase(), unit: s.unit.toUpperCase() };
    let pts = clip(s.points, from, to);
    if (m.map) pts = pts.map(([x, y]) => [x, m.map!(y)] as Point);
    if (look.step) pts = holdTo(pts, Math.min(now, to));
    return { key: s.metric, label: m.label, short: m.short, points: pts, style: m.style ?? 'solid', step: look.step, gap: look.gap, look: m };
  });
  const unit = (series[0]?.look.unit ?? spec.unit).toUpperCase();
  const fmt = (m: MetricLook) => (v: number | null) => (v == null ? '--' : v.toFixed(m.digits ?? 1));
  const empty = series.every((s) => s.points.length === 0);
  return (
    <>
      {head}
      <SeriesChart
        series={series}
        from={from}
        to={to}
        now={ahead > 0 ? now : null}
        lines={8}
        zero={look.zero}
        fmtV={(k, v) => {
          const m = series.find((x) => x.key === k)?.look;
          return `${v.toFixed(m?.digits ?? 1)} ${m?.unit ?? unit}`.trim();
        }}
        minSpan={look.minSpan}
        ticks={hourTicks(from, to, now)}
        label={`${spec.label}, ${rangeLabel(spec).toLowerCase()}, ${series.map((s) => s.label.toLowerCase()).join(', ')}`}
      />
      {empty ? (
        <Line muted>NO READINGS IN THE LAST {hours} H</Line>
      ) : (
        series.map((s) => {
          const ys = s.points.map((p) => p[1]);
          const f = fmt(s.look);
          const lo = ys.length ? Math.min(...ys) : null;
          const hi = ys.length ? Math.max(...ys) : null;
          return (
            <Readout
              key={s.key}
              k={`${GLYPH[s.style ?? 'solid']} ${s.label}`}
              v={`NOW ${f(valueAt(s.points, now))} ${s.look.unit ?? unit}`.trim()}
              r={<span className="muted">{`${f(lo)}–${f(hi)}`}</span>}
            />
          );
        })
      )}
    </>
  );
}
