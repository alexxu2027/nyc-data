import { describe, expect, it } from 'vitest';
import type { FilterDef, LayerDef, LayerFeature, LayerMeta, SourceHealth } from '../types';
import {
  allEnum,
  changesLabel,
  controlValue,
  countBy,
  enumIsAll,
  fmtClock,
  fmtCountdown,
  fmtDuration,
  fmtPoll,
  groupLayers,
  nextEnum,
  nextSelect,
  nextToggle,
  planLegend,
  rowState,
  sortSources,
  worstState,
  type RowInput,
} from './helpers';

function layer(id: string, group: string, z: number, extra: Partial<LayerDef> = {}): LayerDef {
  return {
    id,
    label: id,
    short: id,
    group,
    kind: 'point',
    sources: [],
    default: false,
    poll_s: 60,
    z,
    borough_filter: true,
    list: false,
    detail: { type: 'none' },
    attribution: { text: '', url: '' },
    lag_note: null,
    empty_text: null,
    legend_title: '',
    filters: [],
    style: { color: { value: 'ink' } },
    legend: [],
    raster: null,
    changes: null,
    ...extra,
  };
}

const META: LayerMeta = {
  layer: 'x',
  count: 20000,
  total: 65799,
  truncated: false,
  unlocated: 0,
  data_as_of: null,
  updated_at: null,
  window: null,
  note: null,
};

function view(p: Partial<RowInput> = {}): RowInput {
  return {
    visible: true,
    status: 'ready',
    count: 10,
    total: 10,
    meta: { ...META, truncated: false },
    error: null,
    rev: 1,
    fetchedAt: 1_000,
    nextAt: 61_000,
    ...p,
  };
}

const DEF = { empty_text: null, list: false };

describe('groupLayers', () => {
  const catalog = {
    groups: [
      { id: 'transit', label: 'Transit' },
      { id: 'water', label: 'Water' },
      { id: 'empty', label: 'Empty' },
      { id: 'reference', label: 'Reference' },
    ],
    layers: [
      layer('boroughs', 'reference', 5),
      layer('stations', 'transit', 35),
      layer('alerts', 'transit', 65),
      layer('bike', 'transit', 45),
      layer('tide', 'water', 85),
      layer('stray', 'nope', 1),
      layer('b', 'water', 70),
      layer('a', 'water', 70),
    ],
  };

  it('keeps catalog group order and drops empty groups', () => {
    expect(groupLayers(catalog).map((g) => g.id)).toEqual(['transit', 'water', 'reference', '_other']);
  });

  it('puts the top-most layer first inside a group, ties by label', () => {
    const g = groupLayers(catalog);
    expect(g[0].layers.map((l) => l.id)).toEqual(['alerts', 'bike', 'stations']);
    expect(g[1].layers.map((l) => l.id)).toEqual(['tide', 'a', 'b']);
  });

  it('collects layers with an unknown group into a trailing Other group', () => {
    const other = groupLayers(catalog).at(-1)!;
    expect(other.label).toBe('Other');
    expect(other.layers.map((l) => l.id)).toEqual(['stray']);
  });

  it('does not mutate the catalog', () => {
    const before = catalog.layers.map((l) => l.id);
    groupLayers(catalog);
    expect(catalog.layers.map((l) => l.id)).toEqual(before);
  });
});

describe('rowState', () => {
  it('a hidden layer is off and keeps its last count', () => {
    const r = rowState(view({ visible: false }), 'ok', DEF, 0);
    expect(r).toMatchObject({ dot: 'off', count: 10, notes: [] });
    expect(rowState(view({ visible: false, rev: 0 }), 'ok', DEF, 0).count).toBeNull();
  });

  it('loading before the first response', () => {
    for (const status of ['idle', 'loading'] as const) {
      const r = rowState(view({ status, rev: 0, meta: null }), 'ok', DEF, 0);
      expect(r.dot).toBe('loading');
      expect(r.count).toBeNull();
      expect(r.notes.map((n) => n.key)).toEqual(['loading']);
    }
  });

  it('an error with no data says so and when it retries', () => {
    const r = rowState(view({ status: 'error', rev: 0, meta: null, error: 'HTTP 503', nextAt: 120_000 }), 'ok', DEF, 0);
    expect(r.dot).toBe('degraded');
    expect(r.count).toBeNull();
    expect(r.notes).toEqual([{ key: 'error', tone: 'warn', text: 'COULD NOT LOAD, RETRYING IN 2 MIN' }]);
  });

  it('an error with old data keeps the count and flags the age', () => {
    const r = rowState(view({ status: 'error', error: 'x', fetchedAt: 0 }), 'ok', DEF, 180_000);
    expect(r.count).toBe(10);
    expect(r.dot).toBe('ok');
    expect(r.notes[0]).toEqual({ key: 'error', tone: 'warn', text: 'UPDATE FAILED, SHOWING DATA FROM 3 MIN AGO' });
  });

  it('ready: the dot is the worst source health', () => {
    expect(rowState(view(), 'stale', DEF, 0).dot).toBe('stale');
    expect(rowState(view(), 'unknown', DEF, 0).dot).toBe('unknown');
    expect(rowState(view(), 'degraded', DEF, 0).notes.map((n) => n.text)).toEqual(['FEED FAILING: SEE HEALTH']);
  });

  it('a feed with no data yet shows one plain note and no count (UX review B8)', () => {
    const r = rowState(view({ count: 0, total: 0 }), 'never', { empty_text: 'No trains reporting', list: false }, 0);
    expect(r.count).toBeNull();
    expect(r.notes.map((n) => n.text)).toEqual(['NO DATA COLLECTED YET']);
  });

  it('empty uses the catalog empty_text', () => {
    const r = rowState(view({ count: 0, total: 0 }), 'ok', { empty_text: 'No active alerts for NYC', list: true }, 0);
    expect(r.count).toBe(0);
    expect(r.notes).toEqual([{ key: 'empty', tone: 'muted', text: 'NO ACTIVE ALERTS FOR NYC' }]);
  });

  it('filtered to nothing is not the same as empty', () => {
    const r = rowState(view({ count: 0, total: 2519 }), 'ok', DEF, 0);
    expect(r.notes).toEqual([{ key: 'filtered', tone: 'muted', text: 'NONE OF 2,519 MATCH THE FILTERS' }]);
  });

  it('truncated and unlocated are spelled out', () => {
    const meta = { ...META, truncated: true, count: 20000, total: 65799, unlocated: 37 };
    const r = rowState(view({ meta, count: 20000, total: 20000 }), 'ok', { empty_text: null, list: true }, 0);
    expect(r.notes.map((n) => n.text)).toEqual(['SHOWING NEWEST 20,000 OF 65,799', '37 NOT ON MAP · IN LIST']);
    expect(rowState(view({ meta: { ...META, unlocated: 3 } }), 'ok', DEF, 0).notes[0].text).toBe('3 NOT ON MAP');
  });
});

describe('filter control → setFilter value', () => {
  const en: FilterDef = {
    key: 'state',
    label: 'State',
    type: 'enum',
    apply: 'client',
    prop: 'state',
    options: [
      { value: 'empty', label: 'No bikes' },
      { value: 'low', label: 'Low' },
      { value: 'ok', label: 'OK' },
    ],
    default: ['empty', 'low', 'ok'],
  };
  const sel: FilterDef = {
    key: 'window',
    label: 'Window',
    type: 'select',
    apply: 'server',
    options: [
      { value: '24h', label: '24 h' },
      { value: '48h', label: '48 h' },
    ],
    default: '24h',
  };
  const tog: FilterDef = { key: 'ebikes', label: 'E', type: 'toggle', apply: 'client', default: false };

  it('enum: unchecking removes, checking adds back in option order', () => {
    expect(nextEnum(en, ['empty', 'low', 'ok'], 'low', false)).toEqual(['empty', 'ok']);
    expect(nextEnum(en, ['ok', 'empty'], 'low', true)).toEqual(['empty', 'low', 'ok']);
    expect(nextEnum(en, ['empty'], 'empty', false)).toEqual([]);
  });

  it('enum: unknown options and non-array values are ignored', () => {
    expect(nextEnum(en, ['empty', 'zzz'], 'ok', true)).toEqual(['empty', 'ok']);
    expect(nextEnum(en, true, 'ok', true)).toEqual(['ok']);
  });

  it('enum: ALL and the all-selected test', () => {
    expect(allEnum(en)).toEqual(['empty', 'low', 'ok']);
    expect(enumIsAll(en, ['ok', 'low', 'empty'])).toBe(true);
    expect(enumIsAll(en, ['ok'])).toBe(false);
  });

  it('select: takes the option value, unknown falls back to the default', () => {
    expect(nextSelect(sel, '48h')).toBe('48h');
    expect(nextSelect(sel, '1y')).toBe('24h');
  });

  it('toggle: a boolean', () => {
    expect(nextToggle(true)).toBe(true);
    expect(nextToggle(false)).toBe(false);
  });

  it('controlValue: override else default', () => {
    expect(controlValue(sel, undefined)).toBe('24h');
    expect(controlValue(sel, { window: '48h' })).toBe('48h');
    expect(controlValue(tog, { other: true })).toBe(false);
  });
});

describe('planLegend', () => {
  it('moves swatches onto enum options with the same label', () => {
    const def = {
      legend: [
        { label: 'Noise', shape: 'circle' as const, color: '#e69f00' },
        { label: 'Other', shape: 'circle' as const, color: '#999999' },
        { label: 'Closed', shape: 'ring' as const, color: 'muted' },
      ],
      filters: [
        {
          key: 'group',
          label: 'Type',
          type: 'enum' as const,
          apply: 'client' as const,
          prop: 'group',
          options: [
            { value: 'noise', label: 'noise' },
            { value: 'other', label: 'Other ' },
          ],
          default: ['noise', 'other'],
        },
        { key: 'w', label: 'W', type: 'select' as const, apply: 'server' as const, options: [{ value: 'closed', label: 'Closed' }], default: 'closed' },
      ],
    };
    const p = planLegend(def);
    expect(p.onOptions.get('group:noise')?.color).toBe('#e69f00');
    expect(p.onOptions.get('group:other')?.color).toBe('#999999');
    expect(p.rest.map((i) => i.label)).toEqual(['Closed']); // selects never take a swatch
  });
});

describe('countBy', () => {
  it('counts String(prop) and skips null', () => {
    const f = (state: unknown) => ({ type: 'Feature', geometry: null, properties: { id: String(Math.random()), borough: null, state } }) as unknown as LayerFeature;
    const m = countBy([f('ok'), f('ok'), f(1), f('1'), f(null)], 'state');
    expect(Object.fromEntries(m)).toEqual({ ok: 2, 1: 2 });
  });
});

describe('health helpers', () => {
  const src = (id: string, state: SourceHealth['state']): SourceHealth => ({
    id,
    name: id,
    state,
    cadence_s: 60,
    last_success: null,
    last_attempt: null,
    age_s: null,
    lag_s: null,
    consecutive_failures: 0,
    rows_last_run: null,
    last_error: null,
    runs_24h: 0,
    ok_24h: 0,
    layers: [],
  });

  it('sorts worst first, then by name', () => {
    const out = sortSources([src('b', 'ok'), src('a', 'ok'), src('z', 'degraded'), src('s', 'stale'), src('n', 'never')]);
    expect(out.map((s) => s.id)).toEqual(['z', 'n', 's', 'a', 'b']);
  });

  it('worstState from the summary', () => {
    expect(worstState(null)).toBe('unknown');
    expect(worstState({ summary: { ok: 14, stale: 0, degraded: 0, never: 0 } })).toBe('ok');
    expect(worstState({ summary: { ok: 13, stale: 1, degraded: 0, never: 0 } })).toBe('stale');
    expect(worstState({ summary: { ok: 12, stale: 1, degraded: 1, never: 0 } })).toBe('degraded');
  });
});

describe('formatting', () => {
  it('durations', () => {
    expect(fmtDuration(null)).toBe('--');
    expect(fmtDuration(42)).toBe('42 S');
    expect(fmtDuration(600)).toBe('10 MIN');
    expect(fmtDuration(3600 * 3 + 60 * 20)).toBe('3 H 20 MIN');
    expect(fmtDuration(86400 * 2 + 3600 * 4)).toBe('2 D 4 H');
  });

  it('poll cadence is never below 30 s', () => {
    expect(fmtPoll(0)).toBe('LOADED ONCE');
    expect(fmtPoll(10)).toBe('EVERY 30 S');
    expect(fmtPoll(3600)).toBe('EVERY 1 H');
  });

  it('countdown keeps its shape', () => {
    expect(fmtCountdown(null)).toBe('--:--');
    expect(fmtCountdown(-5)).toBe('0:00');
    expect(fmtCountdown(42_000)).toBe('0:42');
    expect(fmtCountdown(3_723_000)).toBe('1:02:03');
  });

  it('clock renders New York time with seconds across DST', () => {
    expect(fmtClock(Date.parse('2026-11-15T20:28:05Z'))).toBe('3:28:05 PM ET'); // EST
    expect(fmtClock(Date.parse('2026-07-01T16:00:09Z'))).toBe('12:00:09 PM ET'); // EDT
  });

  it('changes button shows the unread count, capped', () => {
    expect(changesLabel(0)).toBe('CHANGES');
    expect(changesLabel(3)).toBe('CHANGES (3 NEW)');
    expect(changesLabel(100)).toBe('CHANGES (99+ NEW)');
    expect(changesLabel(Number.NaN)).toBe('CHANGES');
  });
});
