import { describe, expect, it } from 'vitest';
import type { LayerDef } from '../types';
import { applyClientFilters, effectiveFilters, matchesWhere, serverParams } from './filters';
import { catalog, feat } from './test/fixtures';

const def = (id: string) => catalog.layers.find((l) => l.id === id) as LayerDef;
const P = (o: Record<string, unknown>) => ({ id: 'x', borough: null, ...o }) as const;

describe('matchesWhere', () => {
  it('eq / ne compare strictly, then as strings', () => {
    expect(matchesWhere(P({ s: 'a' }), { prop: 's', op: 'eq', value: 'a' })).toBe(true);
    expect(matchesWhere(P({ s: 3 }), { prop: 's', op: 'eq', value: '3' })).toBe(true);
    expect(matchesWhere(P({ s: true }), { prop: 's', op: 'eq', value: true })).toBe(true);
    expect(matchesWhere(P({ s: false }), { prop: 's', op: 'eq', value: true })).toBe(false);
    expect(matchesWhere(P({}), { prop: 's', op: 'eq', value: 'a' })).toBe(false);
    expect(matchesWhere(P({ s: 'b' }), { prop: 's', op: 'ne', value: 'a' })).toBe(true);
    expect(matchesWhere(P({ s: 'a' }), { prop: 's', op: 'ne', value: 'a' })).toBe(false);
    expect(matchesWhere(P({}), { prop: 's', op: 'ne', value: 'a' })).toBe(true);
  });
  it('gt / gte / lt / lte are numeric and never match null', () => {
    const w = (op: 'gt' | 'gte' | 'lt' | 'lte', v: number) => ({ prop: 'n', op, value: v });
    expect(matchesWhere(P({ n: 5 }), w('gt', 4))).toBe(true);
    expect(matchesWhere(P({ n: 4 }), w('gt', 4))).toBe(false);
    expect(matchesWhere(P({ n: 4 }), w('gte', 4))).toBe(true);
    expect(matchesWhere(P({ n: 3 }), w('lt', 4))).toBe(true);
    expect(matchesWhere(P({ n: 4 }), w('lt', 4))).toBe(false);
    expect(matchesWhere(P({ n: 4 }), w('lte', 4))).toBe(true);
    expect(matchesWhere(P({ n: '12' }), w('gte', 12))).toBe(true);
    expect(matchesWhere(P({ n: null }), w('lt', 4))).toBe(false);
    expect(matchesWhere(P({}), w('lte', 4))).toBe(false);
    expect(matchesWhere(P({ n: 'abc' }), w('lt', 4))).toBe(false);
  });
  it('in matches any element, by string', () => {
    expect(matchesWhere(P({ s: 'b' }), { prop: 's', op: 'in', value: ['a', 'b'] })).toBe(true);
    expect(matchesWhere(P({ s: 2 }), { prop: 's', op: 'in', value: ['1', '2'] })).toBe(true);
    expect(matchesWhere(P({ s: 'c' }), { prop: 's', op: 'in', value: ['a', 'b'] })).toBe(false);
    expect(matchesWhere(P({ s: 'a' }), { prop: 's', op: 'in', value: 'a' })).toBe(true);
  });
});

describe('effectiveFilters', () => {
  it('fills defaults and applies overrides', () => {
    expect(effectiveFilters(def('citibike'))).toEqual({ state: ['empty', 'low', 'ok', 'full', 'offline'], ebikes: false });
    expect(effectiveFilters(def('citibike'), { ebikes: true })).toEqual({ state: ['empty', 'low', 'ok', 'full', 'offline'], ebikes: true });
  });
});

describe('applyClientFilters', () => {
  it('enum compares String(v)', () => {
    const d = def('collisions');
    const fs = [feat('a', 'MN', { severity: 1 }), feat('b', 'MN', { severity: 3 }), feat('c', 'MN', { severity: null })];
    const out = applyClientFilters(fs, d, effectiveFilters(d, { severity: ['3'] }), []);
    expect(out.map((f) => f.properties.id)).toEqual(['b']);
    // empty selection hides everything
    expect(applyClientFilters(fs, d, effectiveFilters(d, { severity: [] }), [])).toEqual([]);
    // every option selected (the default) is a no-op: null / unexpected values still show
    expect(applyClientFilters(fs, d, effectiveFilters(d), [])).toBe(fs);
  });

  it('select applies the chosen option where; an option without where passes all', () => {
    const d = def('flood_events');
    const fs = [feat('a', 'BK', { max_depth_in: 2 }), feat('b', 'BK', { max_depth_in: 5 }), feat('c', 'BK', { max_depth_in: 20 })];
    expect(applyClientFilters(fs, d, effectiveFilters(d), [])).toBe(fs);
    expect(applyClientFilters(fs, d, effectiveFilters(d, { depth: '4' }), []).map((f) => f.properties.id)).toEqual(['b', 'c']);
    expect(applyClientFilters(fs, d, effectiveFilters(d, { depth: '12' }), []).map((f) => f.properties.id)).toEqual(['c']);
  });

  it('toggle applies where only when true', () => {
    const d = def('subway_stations');
    const fs = [feat('a', 'MN', { ada: 0 }), feat('b', 'MN', { ada: 1 }), feat('c', 'MN', { ada: 2 })];
    expect(applyClientFilters(fs, d, effectiveFilters(d), []).length).toBe(3);
    expect(applyClientFilters(fs, d, effectiveFilters(d, { ada: true }), []).map((f) => f.properties.id)).toEqual(['b', 'c']);
  });

  it('server filters are not applied client-side', () => {
    const d = def('complaints_311');
    const fs = [feat('a', 'MN', { group: 'noise', status: 'open' })];
    expect(applyClientFilters(fs, d, effectiveFilters(d, { window: '7d' }), [])).toBe(fs);
  });

  it('borough rule: null passes, XX hidden when any borough is selected', () => {
    const d = def('citibike');
    const fs = [feat('mn', 'MN'), feat('bk', 'BK'), feat('nj', 'XX'), feat('nul', null)];
    const v = effectiveFilters(d);
    expect(applyClientFilters(fs, d, v, [])).toBe(fs); // all boroughs: XX shown
    expect(applyClientFilters(fs, d, v, ['BK']).map((f) => f.properties.id)).toEqual(['bk', 'nul']);
    expect(applyClientFilters(fs, d, v, ['MN', 'BK']).map((f) => f.properties.id)).toEqual(['mn', 'bk', 'nul']);
  });

  it('borough rule is skipped when borough_filter is false', () => {
    const d = def('boroughs');
    const fs = [feat('mn', 'MN'), feat('bk', 'BK')];
    expect(applyClientFilters(fs, d, {}, ['BK'])).toBe(fs);
  });

  it('combines borough and filters', () => {
    const d = def('citibike');
    const fs = [feat('a', 'BK', { state: 'empty', ebikes: 2 }), feat('b', 'BK', { state: 'ok', ebikes: 2 }), feat('c', 'MN', { state: 'empty', ebikes: 1 }), feat('d', 'BK', { state: 'empty', ebikes: 0 })];
    const v = effectiveFilters(d, { state: ['empty'], ebikes: true });
    expect(applyClientFilters(fs, d, v, ['BK']).map((f) => f.properties.id)).toEqual(['a']);
  });
});

describe('serverParams', () => {
  it('emits only server filters, as f.<key>', () => {
    const d = def('complaints_311');
    expect(serverParams(d, effectiveFilters(d))).toEqual({ 'f.window': '24h' });
    expect(serverParams(d, effectiveFilters(d, { window: '48h', status: ['open'] }))).toEqual({ 'f.window': '48h' });
    expect(serverParams(def('citibike'), effectiveFilters(def('citibike'), { ebikes: true }))).toEqual({});
  });
  it('encodes toggles as 1 and enums as comma lists', () => {
    const d: LayerDef = {
      ...def('citibike'),
      filters: [
        { key: 't', label: 't', type: 'toggle', apply: 'server', default: false },
        { key: 'e', label: 'e', type: 'enum', apply: 'server', prop: 'e', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], default: ['a', 'b'] },
      ],
    };
    expect(serverParams(d, { t: true, e: ['a', 'b'] })).toEqual({ 'f.t': '1', 'f.e': 'a,b' });
    expect(serverParams(d, { t: false, e: ['b'] })).toEqual({ 'f.e': 'b' });
  });
});
