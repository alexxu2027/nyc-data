// Test catalog: a faithful subset of config/layers.yaml (as /api/layers serves it, defaults filled).
import type { Catalog, FilterDef, LayerDef, LayerFeature, LayerCollection, FeatureBorough } from '../../types';

function layer(p: Partial<LayerDef> & Pick<LayerDef, 'id' | 'group' | 'kind'>): LayerDef {
  return {
    label: p.id,
    short: p.id.slice(0, 12),
    sources: [],
    default: false,
    poll_s: 3600,
    z: 50,
    borough_filter: true,
    list: false,
    detail: { type: 'none' },
    attribution: { text: 't', url: 'https://example.org' },
    lag_note: null,
    empty_text: null,
    legend_title: '',
    filters: [],
    style: { color: { value: 'ink' } },
    legend: [],
    ...p,
  };
}

const enumF = (key: string, values: string[], def?: string[], prop = key): FilterDef => ({
  key,
  label: key,
  type: 'enum',
  apply: 'client',
  prop,
  options: values.map((v) => ({ value: v, label: v })),
  default: def ?? values,
});

export const catalog: Catalog = {
  version: 1,
  basemaps: { light: 'l', dark: 'd' },
  view: { center: [-73.955, 40.725], zoom: 10.6, min_zoom: 8.5, max_zoom: 18.5, bounds: [-74.75, 40.2, -73.2, 41.2] },
  boroughs: [
    { id: 'MN', label: 'Manhattan' },
    { id: 'BK', label: 'Brooklyn' },
    { id: 'QN', label: 'Queens' },
    { id: 'BX', label: 'Bronx' },
    { id: 'SI', label: 'Staten Island' },
  ],
  groups: [
    { id: 'transit', label: 'Transit' },
    { id: 'streets', label: 'Streets & safety' },
    { id: 'water', label: 'Water & weather' },
    { id: 'city', label: 'City services' },
    { id: 'reference', label: 'Reference' },
  ],
  layers: [
    layer({ id: 'boroughs', group: 'reference', kind: 'polygon', default: true, poll_s: 0, z: 5, borough_filter: false }),
    layer({
      id: 'nws_alerts',
      group: 'water',
      kind: 'polygon',
      default: true,
      poll_s: 120,
      sources: ['nws_alerts'],
      list: true,
      detail: { type: 'event', source: 'nws_alerts' },
      filters: [enumF('status', ['active', 'upcoming'])],
    }),
    layer({
      id: 'road_speeds',
      group: 'streets',
      kind: 'line',
      default: true,
      poll_s: 300,
      sources: ['dot_traffic_speeds'],
      filters: [enumF('band', ['lt10', '10_20', '20_35', '35_50', 'gte50', 'none'])],
    }),
    layer({
      id: 'complaints_311',
      group: 'city',
      kind: 'cluster',
      sources: ['nyc_311'],
      filters: [
        {
          key: 'window',
          label: 'Window',
          type: 'select',
          apply: 'server',
          options: [
            { value: '24h', label: '24h' },
            { value: '48h', label: '48h' },
            { value: '7d', label: '7d' },
          ],
          default: '24h',
        },
        enumF('group', ['noise', 'housing', 'sanitation', 'streets', 'water', 'social', 'vehicles', 'other']),
        enumF('status', ['open', 'closed']),
      ],
    }),
    layer({
      id: 'subway_stations',
      group: 'transit',
      kind: 'point',
      sources: ['mta_subway_stations'],
      filters: [
        { key: 'ada', label: 'Accessible only', type: 'toggle', apply: 'client', where: { prop: 'ada', op: 'gt', value: 0 }, default: false },
      ],
    }),
    layer({
      id: 'citibike',
      group: 'transit',
      kind: 'point',
      default: true,
      poll_s: 60,
      sources: ['citibike_gbfs', 'citibike_station_status'],
      detail: { type: 'entity', kind: 'bike_station' },
      filters: [
        enumF('state', ['empty', 'low', 'ok', 'full', 'offline']),
        { key: 'ebikes', label: 'E-bikes', type: 'toggle', apply: 'client', where: { prop: 'ebikes', op: 'gt', value: 0 }, default: false },
      ],
    }),
    layer({
      id: 'cameras',
      group: 'streets',
      kind: 'point',
      default: true,
      sources: ['dot_cameras'],
      detail: { type: 'entity', kind: 'camera' },
      filters: [enumF('status', ['online', 'offline'])],
    }),
    layer({
      id: 'collisions',
      group: 'streets',
      kind: 'point',
      sources: ['nyc_collisions'],
      filters: [
        {
          key: 'window',
          label: 'Window',
          type: 'select',
          apply: 'server',
          options: [
            { value: '7d', label: '7d' },
            { value: '14d', label: '14d' },
          ],
          default: '7d',
        },
        enumF('severity', ['1', '2', '3']),
        { key: 'ped', label: 'Ped', type: 'toggle', apply: 'client', where: { prop: 'ped', op: 'eq', value: true }, default: false },
      ],
    }),
    layer({
      id: 'subway_alerts',
      group: 'transit',
      kind: 'point',
      default: true,
      poll_s: 60,
      list: true,
      sources: ['mta_subway_alerts', 'mta_subway_stations'],
      filters: [
        enumF('status', ['active', 'upcoming'], ['active']),
        { key: 'unplanned', label: 'Unplanned', type: 'toggle', apply: 'client', where: { prop: 'unplanned', op: 'gt', value: 0 }, default: false },
      ],
    }),
    layer({
      id: 'flood_events',
      group: 'water',
      kind: 'point',
      default: true,
      sources: ['floodnet_events', 'floodnet_sensors'],
      filters: [
        {
          key: 'window',
          label: 'Window',
          type: 'select',
          apply: 'server',
          options: [
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
          ],
          default: '30d',
        },
        {
          key: 'depth',
          label: 'Depth',
          type: 'select',
          apply: 'client',
          options: [
            { value: 'any', label: 'Any depth' },
            { value: '4', label: '4+', where: { prop: 'max_depth_in', op: 'gte', value: 4 } },
            { value: '12', label: '12+', where: { prop: 'max_depth_in', op: 'gte', value: 12 } },
          ],
          default: 'any',
        },
      ],
    }),
  ],
};

export function feat(id: string, borough: FeatureBorough, props: Record<string, unknown> = {}): LayerFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.9, 40.7] }, properties: { id, borough, ...props } };
}

export function collection(layer: string, features: LayerFeature[]): LayerCollection {
  return {
    type: 'FeatureCollection',
    meta: {
      layer,
      count: features.length,
      total: features.length,
      truncated: false,
      unlocated: 0,
      data_as_of: '2026-11-15T03:00:00Z',
      updated_at: '2026-11-15T03:00:00Z',
      window: null,
      note: null,
    },
    features,
  };
}
