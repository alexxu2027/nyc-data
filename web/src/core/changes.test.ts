import { describe, expect, it } from 'vitest';
import type { ChangesDef, LayerDef } from '../types';
import { changedIds } from './changes';
import { catalog, feat } from './test/fixtures';

const base = catalog.layers.find((l) => l.id === 'citibike')!;
const def = (changes: ChangesDef | null): LayerDef => ({ ...base, changes });

const prev = [feat('a', 'MN', { state: 'ok', bikes: 7 }), feat('b', 'MN', { state: 'ok', bikes: 2 })];

describe('changedIds', () => {
  it('reports nothing on the first load', () => {
    const next = [feat('a', 'MN', { state: 'empty' }), feat('c', 'MN', { state: 'ok' })];
    expect(changedIds(def({ props: ['state'], new: true }), [], next, true)).toEqual([]);
    expect(changedIds(def({ props: ['state'], new: true }), prev, next, true)).toEqual([]);
  });

  it('reports nothing for a layer without a changes entry', () => {
    const next = [feat('a', 'MN', { state: 'empty', bikes: 0 })];
    expect(changedIds(def(null), prev, next, false)).toEqual([]);
  });

  it('counts only the listed props', () => {
    const next = [feat('a', 'MN', { state: 'ok', bikes: 6 }), feat('b', 'MN', { state: 'empty', bikes: 0 })];
    expect(changedIds(def({ props: ['state'], new: false }), prev, next, false)).toEqual(['b']);
    expect(changedIds(def({ props: ['bikes'], new: false }), prev, next, false)).toEqual(['a', 'b']);
    expect(changedIds(def({ props: [], new: false }), prev, next, false)).toEqual([]);
    // A prop appearing or disappearing counts; equal arrays do not.
    const p2 = [feat('a', 'MN', { tags: [1, 2] }), feat('b', 'MN', {})];
    const n2 = [feat('a', 'MN', { tags: [1, 2] }), feat('b', 'MN', { tags: [3] })];
    expect(changedIds(def({ props: ['tags'], new: false }), p2, n2, false)).toEqual(['b']);
  });

  it('reports new ids only when changes.new', () => {
    const next = [...prev, feat('c', 'MN', { state: 'ok', bikes: 9 })];
    expect(changedIds(def({ props: ['state'], new: true }), prev, next, false)).toEqual(['c']);
    expect(changedIds(def({ props: ['state'], new: false }), prev, next, false)).toEqual([]);
    // Ids that disappeared are not reported (nothing left to flash).
    expect(changedIds(def({ props: ['state'], new: true }), prev, [prev[0]], false)).toEqual([]);
  });
});
