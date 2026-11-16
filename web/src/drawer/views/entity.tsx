// Entity views (catalog `detail: entity:<kind>`). Readouts come from the feature first, so they
// match the map exactly and show before the detail fetch returns; the detail adds history,
// derived values and linked events.
import { fmtTime, useApp } from '../../core';
import type { EntityDetail, EventSummary, FeatureProps } from '../../types';
import { Blank, Heading, Line, Num, Readout } from '../../ui';
import { CameraFrame } from '../CameraFrame';
import { depthFromTitle, fixed, fmtDuration, num, signed } from '../detail';
import { EventItem, Loading, SeriesBlock } from './common';

export interface EntityViewProps {
  kind: string;
  id: string;
  props: Partial<FeatureProps> | undefined;
  detail: EntityDetail | undefined;
  rev: number;
}

const dt = (ts: string) => fmtTime(ts, 'datetime');
const latest = (d: EntityDetail | undefined, m: string) => d?.latest[m]?.value ?? null;
const pick = (...vs: unknown[]): number | null => {
  for (const v of vs) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
};
const yesNo = (v: unknown) => (v === true || (typeof v === 'number' && v > 0) ? 'YES' : v == null ? '--' : 'NO');

function Series({ kind, id, detail, rev }: EntityViewProps) {
  if (!detail) return <Loading>LOADING HISTORY…</Loading>;
  return (
    <>
      {detail.series.map((spec) => (
        <div key={spec.metrics.join(',')} className="drw-block">
          <Blank />
          <SeriesBlock kind={kind} id={id} spec={spec} rev={rev} />
        </div>
      ))}
    </>
  );
}

// ---- Camera ---------------------------------------------------------------------------------

function CameraView(p: EntityViewProps) {
  const url = (p.props?.image_url as string | undefined) ?? (p.detail?.derived.image_url as string | undefined);
  const status = (p.props?.status as string | undefined) ?? (p.detail?.derived.status as string | undefined);
  const name = (p.props?.name as string | undefined) ?? p.detail?.name ?? p.id;
  if (!url) return <Loading>LOOKING UP THE CAMERA FEED…</Loading>;
  return (
    <>
      <CameraFrame key={url} url={url} name={name} offline={status === 'offline'} />
      <Readout k="STATUS" v={status ? status.toUpperCase() : '--'} r="NYC DOT" />
    </>
  );
}

// ---- Citi Bike --------------------------------------------------------------------------------

const BIKE_STATE: Record<string, string> = {
  empty: 'NO BIKES',
  low: '1–3 BIKES',
  ok: 'BIKES AND DOCKS',
  full: 'NO DOCKS',
  offline: 'NOT RENTING',
};

function BikeView(p: EntityViewProps) {
  const bikes = pick(p.props?.bikes, latest(p.detail, 'bikes_available'));
  const ebikes = pick(p.props?.ebikes, latest(p.detail, 'ebikes_available'));
  const docks = pick(p.props?.docks, latest(p.detail, 'docks_available'));
  const cap = pick(p.props?.capacity, p.detail?.props.capacity);
  const pct = pick(p.props?.pct, p.detail?.derived.pct);
  const state = (p.props?.state as string | undefined) ?? (p.detail?.derived.state as string | undefined);
  return (
    <>
      <Readout k="BIKES" v={<Num value={bikes} width={4} />} r={ebikes == null ? undefined : `${ebikes} ELECTRIC`} />
      <Readout k="DOCKS FREE" v={<Num value={docks} width={4} />} r={cap == null ? undefined : `OF ${cap}`} />
      <Readout
        k="STATE"
        v={state ? (BIKE_STATE[state] ?? state.toUpperCase()) : '--'}
        r={pct == null ? undefined : `BIKES IN ${Math.round(pct * 100)}% OF DOCKS`}
      />
      <Series {...p} />
    </>
  );
}

// ---- Tide -----------------------------------------------------------------------------------

const TREND: Record<string, string> = { rising: '▲ RISING', falling: '▼ FALLING', steady: '= STEADY' };

function TideView(p: EntityViewProps) {
  const d = p.detail?.derived ?? {};
  const level = pick(p.props?.water_level_ft, latest(p.detail, 'water_level_ft'));
  const predicted = pick(p.props?.predicted_ft, d.predicted_ft);
  const surge = pick(p.props?.surge_ft, d.surge_ft);
  const trend = (p.props?.trend as string | null | undefined) ?? (d.trend as string | null | undefined);
  const tides = (['next_high', 'next_low'] as const)
    .map((k) => ({ k, v: d[k] as { at: string; ft: number } | null | undefined }))
    .filter((t): t is { k: 'next_high' | 'next_low'; v: { at: string; ft: number } } => !!t.v)
    .sort((a, b) => Date.parse(a.v.at) - Date.parse(b.v.at));
  return (
    <>
      <Readout k="WATER LEVEL" v={`${fixed(level, 2)} FT`} r={trend ? TREND[trend] ?? trend.toUpperCase() : undefined} />
      <Readout k="PREDICTED" v={`${fixed(predicted, 2)} FT`} r="NOAA TIDE TABLE" />
      <Readout k="SURGE" v={`${signed(surge)} FT`} r={<span className="muted">OBSERVED − PREDICTED</span>} />
      {!p.detail ? null : tides.length === 0 ? (
        <Readout k="NEXT TIDE" v="--" />
      ) : (
        tides.map((t) => (
          <Readout
            key={t.k}
            k={t.k === 'next_high' ? 'NEXT HIGH' : 'NEXT LOW'}
            v={dt(t.v.at)}
            r={`${fixed(t.v.ft, 2)} FT`}
          />
        ))
      )}
      <Line muted>Heights in feet above mean lower low water (MLLW).</Line>
      <Series {...p} />
    </>
  );
}

// ---- Road speed -----------------------------------------------------------------------------

const BAND: Record<string, string> = {
  lt10: 'UNDER 10 MPH',
  '10_20': '10–20 MPH',
  '20_35': '20–35 MPH',
  '35_50': '35–50 MPH',
  gte50: '50+ MPH',
  none: 'NO READING',
};

function RoadView(p: EntityViewProps) {
  const speed = pick(p.props?.speed_mph, latest(p.detail, 'speed_mph'));
  const tt = pick(p.props?.travel_time_s, latest(p.detail, 'travel_time_s'));
  const band = (p.props?.band as string | undefined) ?? (p.detail?.derived.band as string | undefined);
  const stale = (p.props?.stale as boolean | undefined) ?? (p.detail?.derived.stale as boolean | undefined);
  const owner = (p.props?.owner as string | null | undefined) ?? (p.detail?.props.owner as string | undefined);
  return (
    <>
      <Readout k="SPEED" v={`${fixed(speed, 1)} MPH`} r={band ? BAND[band] : undefined} />
      <Readout k="TRAVEL TIME" v={tt == null ? '--' : tt < 120 ? `${tt} s` : fmtDuration(tt / 60)} />
      {owner && <Readout k="OPERATOR" v={owner} />}
      {stale && <Line muted>Reading is more than 3 hours old.</Line>}
      <Series {...p} />
    </>
  );
}

// ---- Weather --------------------------------------------------------------------------------

function WeatherView(p: EntityViewProps) {
  const tc = pick(p.props?.temp_c, latest(p.detail, 'temp_c'));
  const tf = pick(p.props?.temp_f, p.detail?.derived.temp_f);
  const wind = pick(p.props?.wind_mph, p.detail?.derived.wind_mph);
  const precip = pick(p.props?.precip_mm, latest(p.detail, 'precip_mm'));
  const rain = pick(p.props?.rain_mm, latest(p.detail, 'rain_mm'));
  const wet = (p.props?.wet as boolean | undefined) ?? (p.detail?.derived.wet as boolean | undefined);
  return (
    <>
      <Readout k="TEMPERATURE" v={`${fixed(tf, 1)} °F`} r={`${fixed(tc, 1)} °C`} />
      <Readout k="WIND" v={`${fixed(wind, 1)} MPH`} />
      <Readout
        k="PRECIP"
        v={`${fixed(mmToIn(precip), 2)} IN`}
        r={rain == null || rain === precip ? undefined : `RAIN ${fixed(mmToIn(rain), 2)} IN`}
      />
      <Readout k="NOW" v={wet == null ? '--' : wet ? 'PRECIPITATION FALLING' : 'DRY'} />
      <Series {...p} />
    </>
  );
}

// ---- Flood sensor ---------------------------------------------------------------------------

/** The live-depth ledger row: a reading now, an old reading, or none ever collected. */
export function floodDepthReadout(depth: number | null, live: boolean, at: string | null | undefined) {
  if (depth !== null && live) return { k: 'DEPTH NOW', v: `${depth.toFixed(1)} IN`, r: at ? fmtTime(at) : undefined };
  if (depth !== null) return { k: 'DEPTH', v: 'NO READING', r: `SINCE ${at ? fmtTime(at) : '--'}` };
  return { k: 'DEPTH', v: '--', r: 'LIVE DEPTH NOT COLLECTED YET' };
}

function FloodSensorView(p: EntityViewProps) {
  const select = useApp((s) => s.select);
  const flyTo = useApp((s) => s.flyTo);
  const eventsOn = useApp((s) => s.visible.includes('flood_events'));
  const tidal = p.props?.tidal ?? p.detail?.props.tidally_influenced;
  const n30 = pick(p.props?.events_30d, p.detail?.derived.events_30d);
  const nta = (p.props?.nta as string | null | undefined) ?? (p.detail?.props.nta as string | undefined);
  const installed = p.detail?.props.date_installed as string | undefined;
  const events = p.detail?.events ?? [];
  const d = p.detail?.derived ?? {};
  const depth = pick(p.props?.depth_in, d.depth_in);
  const live = (p.props?.live ?? d.live) === true;
  const depthAt = (p.props?.depth_at as string | null | undefined) ?? p.detail?.latest.depth_in?.observed_at;
  const flooding = (p.props?.flooding ?? d.flooding) === true;
  const since = p.props?.flood_since as string | null | undefined;
  const reading = floodDepthReadout(depth, live, depthAt);
  return (
    <>
      <Readout {...reading} />
      {flooding && <Readout k="FLOODING" v="YES" r={since ? `SINCE ${fmtTime(since)}` : 'NOW'} />}
      <Series {...p} />
      <Blank />
      <Readout k="FLOODS, 30 D" v={<Num value={n30} width={4} />} r="OF DATA" />
      <Readout k="TIDAL" v={yesNo(tidal)} r={nta ? `NTA ${nta}` : undefined} />
      {installed && <Readout k="INSTALLED" v={fmtTime(installed, 'date')} />}
      <Blank />
      <Heading>RECENT FLOODS</Heading>
      {!p.detail ? (
        <Loading>LOADING FLOOD EVENTS…</Loading>
      ) : events.length === 0 ? (
        <Line muted>NO FLOODS RECORDED AT THIS SENSOR</Line>
      ) : (
        events.slice(0, 20).map((ev) => <FloodRow key={ev.id} ev={ev} onPick={eventsOn ? () => {
          select({ mode: 'feature', layer: 'flood_events', id: ev.id });
          if (ev.lon != null && ev.lat != null) flyTo({ lng: ev.lon, lat: ev.lat });
        } : undefined} />)
      )}
      {events.length > 20 && <Line muted>{events.length - 20} OLDER FLOODS NOT SHOWN</Line>}
    </>
  );
}

function FloodRow({ ev, onPick }: { ev: EventSummary; onPick?: () => void }) {
  const depth = depthFromTitle(ev.title);
  const mins = ev.ends_at ? (Date.parse(ev.ends_at) - Date.parse(ev.starts_at)) / 60000 : null;
  return (
    <Line onClick={onPick} title={onPick ? 'Show this flood' : undefined} right={depth == null ? '--' : `${depth.toFixed(1)} IN`}>
      {dt(ev.starts_at)} <span className="muted">{fmtDuration(mins)}</span>
    </Line>
  );
}

// ---- Subway station -------------------------------------------------------------------------

function StationView(p: EntityViewProps) {
  const routes =
    (p.detail?.derived.routes as string[] | undefined) ??
    (typeof p.props?.routes === 'string' ? p.props.routes.split(' ').filter(Boolean) : []);
  const ada = p.props?.ada ?? p.detail?.props.ada;
  const line = (p.props?.line as string | undefined) ?? (p.detail?.props.line as string | undefined);
  const structure = (p.props?.structure as string | undefined) ?? (p.detail?.props.structure as string | undefined);
  const events = p.detail?.events ?? [];
  const alerts = events.filter((e) => e.category !== 'elevator_outage');
  const outages = events.filter((e) => e.category === 'elevator_outage');
  return (
    <>
      <Readout k="ROUTES" v={routes.length ? routes.map((r) => `[${r}]`).join(' ') : '--'} />
      <Readout k="ACCESSIBLE" v={ada == null ? '--' : yesNo(ada)} />
      {structure && <Readout k="TYPE" v={structureWord(structure)} />}
      {line && <Readout k="LINE" v={line} />}
      <Blank />
      <Heading>SERVICE ALERTS: {p.detail ? alerts.length : '--'}</Heading>
      {!p.detail ? (
        <Loading>LOADING ALERTS…</Loading>
      ) : alerts.length === 0 ? (
        <Line muted>NO ALERTS IN EFFECT OR IN THE NEXT 7 DAYS</Line>
      ) : (
        alerts.map((ev, i) => (
          <div key={ev.id}>
            {i > 0 && <Blank />}
            <EventItem ev={ev} />
          </div>
        ))
      )}
      <Blank />
      <Heading>ELEVATORS AND ESCALATORS: {p.detail ? outages.length : '--'}</Heading>
      {!p.detail ? null : outages.length === 0 ? (
        <Line muted>NO OUTAGES NOW OR PLANNED</Line>
      ) : (
        outages.map((ev, i) => (
          <div key={ev.id}>
            {i > 0 && <Blank />}
            <EventItem ev={ev} stations={false} />
          </div>
        ))
      )}
    </>
  );
}

// ---- Dispatch -------------------------------------------------------------------------------

function GenericEntity(p: EntityViewProps) {
  const latestRows = p.detail ? Object.entries(p.detail.latest) : [];
  return (
    <>
      {latestRows.map(([k, m]) => (
        <Readout key={k} k={k.replace(/_/g, ' ')} v={String(m.value)} r={dt(m.observed_at)} />
      ))}
      {p.detail && <Series {...p} />}
    </>
  );
}

const VIEWS: Record<string, (p: EntityViewProps) => React.JSX.Element> = {
  camera: CameraView,
  bike_station: BikeView,
  tide_gauge: TideView,
  road_segment: RoadView,
  weather_point: WeatherView,
  flood_sensor: FloodSensorView,
  subway_station: StationView,
};

export function EntityView(p: EntityViewProps) {
  const View = VIEWS[p.kind] ?? GenericEntity;
  return <View {...p} />;
}

/** Weather is in °F and MPH, so precipitation is in inches too (UX review B17). */
function mmToIn(mm: number | null | undefined): number | null {
  return mm == null ? null : mm / 25.4;
}

/** The station dataset's "Structure": "Subway" means underground (UX review B16). */
function structureWord(s: string): string {
  const w = s.trim().toLowerCase();
  if (w === 'subway') return 'UNDERGROUND';
  return s.toUpperCase();
}
