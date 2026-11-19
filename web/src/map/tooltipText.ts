// Hover tooltip copy per layer (plan §7.3): text only, never an image. Pure, so it is tested.
import { fmtInt, fmtTime } from '../core';
import { headsignOnly } from '../core/bus';
import type { LayerDef } from '../types';
import { catKey } from './layers/clusters';

export interface TipLines {
  title: string;
  lines: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const fixed = (v: unknown, d = 1): string => {
  const n = num(v);
  return n === null ? '–' : n.toFixed(d);
};
const signed = (v: unknown, d = 1): string => {
  const n = num(v);
  if (n === null) return '–';
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(d)}`;
};
const when = (v: unknown): string => (typeof v === 'string' && v ? fmtTime(v, 'datetime') : '');

function optionLabel(def: LayerDef | undefined, key: string, value: unknown): string {
  const f = def?.filters.find((x) => x.key === key);
  return f?.options?.find((o) => o.value === String(value))?.label ?? str(value);
}

/** Tooltip text for a hovered feature (or a 311 cluster). */
export function tooltipText(layer: string, p: Record<string, unknown>, def?: LayerDef): TipLines {
  const name = str(p.name);
  switch (layer) {
    case 'citibike': {
      if (p.state === 'offline') return { title: name, lines: ['NOT RENTING'] };
      const lines = [`${plural(num(p.bikes) ?? 0, 'bike')} · ${plural(num(p.docks) ?? 0, 'dock')} free`];
      if ((num(p.ebikes) ?? 0) > 0) lines.push(`${plural(num(p.ebikes) ?? 0, 'e-bike')} among them`);
      return { title: name, lines };
    }
    case 'cameras':
      return { title: name, lines: [p.status === 'offline' ? 'OFFLINE' : 'ONLINE · click for the live frame'] };
    case 'road_speeds': {
      const s = num(p.speed_mph);
      const lines = [s === null ? 'No reading' : `${s.toFixed(0)} mph`];
      if (p.stale === true) lines.push('Reading older than 3 h');
      else if (p.observed_at) lines.push(`as of ${fmtTime(str(p.observed_at))}`);
      return { title: name || 'Road segment', lines };
    }
    case 'complaints_311': {
      if (p.point_count !== undefined) {
        const n = num(p.point_count) ?? 0;
        const groups = (def?.filters.find((f) => f.key === 'group')?.options ?? [])
          .map((o) => ({ label: o.label, n: num(p[catKey(o.value)]) ?? 0 }))
          .filter((g) => g.n > 0)
          .sort((a, b) => b.n - a.n)
          .slice(0, 3);
        return {
          title: plural(n, 'request'),
          lines: [...groups.map((g) => `${fmtInt(g.n)} ${g.label}`), 'Click to zoom in'],
        };
      }
      return {
        title: str(p.type) || '311 request',
        lines: [optionLabel(def, 'group', p.group), `${str(p.status).toUpperCase()} · ${when(p.starts_at)}`],
      };
    }
    case 'subway_stations':
      return {
        title: name,
        lines: [str(p.routes), (num(p.ada) ?? 0) > 0 ? 'Accessible' : 'Not accessible'].filter(Boolean),
      };
    case 'flood_sensors': {
      const depth = num(p.depth_in);
      const lines = [
        depth !== null && p.live === true && typeof p.depth_at === 'string'
          ? `${depth.toFixed(1)} in · ${fmtTime(p.depth_at)}`
          : 'No reading in 2 h',
      ];
      if (p.flooding === true) {
        lines.push(typeof p.flood_since === 'string' ? `Flooding since ${fmtTime(p.flood_since)}` : 'Flooding now');
      }
      return { title: name, lines };
    }
    case 'buses': {
      const head = headsignOnly(str(p.headsign));
      const next = str(p.next_name);
      const lines = [head ? `To ${head}` : '', next ? `Next: ${next}` : ''];
      if (p.service !== 'local' && p.service_name) lines.push(str(p.service_name));
      return { title: `${str(p.route)} bus`, lines: lines.filter(Boolean) };
    }
    case 'air_quality': {
      const pm = num(p.pm25);
      const lines =
        pm !== null && p.live === true
          ? [`PM2.5 ${pm.toFixed(1)} µg/m³ · ${str(p.category_name)}`]
          : ['No reading in 3 h'];
      lines.push(p.monitor === true ? 'Government monitor' : 'Low-cost sensor');
      return { title: name, lines };
    }
    case 'subway_trains': {
      const route = str(p.route);
      const headsign = str(p.headsign);
      const next = str(p.next_name);
      const atStop = p.at_stop === true;
      const lines = [next ? `${atStop ? 'At' : 'Next'}: ${next}` : ''];
      if (!atStop) lines.push('Position estimated between stations');
      return { title: `${route} train${headsign ? ` to ${headsign}` : ''}`, lines: lines.filter(Boolean) };
    }
    case 'collisions': {
      const inj = num(p.injured) ?? 0;
      const kil = num(p.killed) ?? 0;
      const hurt = kil > 0 ? `${plural(kil, 'killed', 'killed')}` : inj > 0 ? `${plural(inj, 'injured', 'injured')}` : 'Property damage';
      return { title: str(p.street) || str(p.title) || 'Collision', lines: [hurt, when(p.starts_at)].filter(Boolean) };
    }
    case 'elevator_outages':
      return {
        title: name,
        lines: [
          `${plural(num(p.n) ?? 0, 'unit')} ${p.status === 'upcoming' ? 'planned out' : 'out'}`,
          str(p.top_title),
          p.est_return ? `Back ${when(p.est_return)}` : '',
        ].filter(Boolean),
      };
    case 'subway_alerts': {
      const n = num(p.n) ?? 0;
      return {
        title: `${name}${p.routes ? ` (${str(p.routes)})` : ''}`,
        lines: [
          str(p.top_title),
          `${plural(n, 'alert')}${(num(p.unplanned) ?? 0) > 0 ? ` · ${fmtInt(num(p.unplanned) ?? 0)} unplanned` : ''}${p.status === 'upcoming' ? ' · upcoming' : ''}`,
        ].filter(Boolean),
      };
    }
    case 'flood_events':
      return { title: name, lines: [`Peak ${fixed(p.max_depth_in)} in`, when(p.starts_at)].filter(Boolean) };
    case 'nws_alerts':
      return {
        title: str(p.event) || 'Weather alert',
        lines: [str(p.headline) || str(p.area), p.ends_at ? `Until ${when(p.ends_at)}` : '', p.status === 'upcoming' ? 'Upcoming' : ''].filter(Boolean),
      };
    case 'city_alerts':
      return {
        title: str(p.event) || 'City alert',
        lines: [str(p.headline) || str(p.area), p.ends_at ? `Until ${when(p.ends_at)}` : ''].filter(Boolean),
      };
    case 'weather':
      return {
        title: name,
        lines: [
          `${fixed(p.temp_f, 0)}°F · wind ${fixed(p.wind_mph, 0)} mph`,
          p.wet === true ? `Precipitation ${fixed(p.precip_mm)} mm` : 'Dry',
        ],
      };
    case 'tide_gauge':
      return {
        title: name,
        lines: [
          `${fixed(p.water_level_ft)} ft above ${str(p.datum) || 'MLLW'}${p.trend ? `, ${str(p.trend)}` : ''}`,
          `Surge ${signed(p.surge_ft)} ft`,
        ],
      };
    default:
      return { title: name || str(p.title) || str(p.id), lines: [] };
  }
}
