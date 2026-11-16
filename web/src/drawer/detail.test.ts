import { describe, expect, it } from 'vitest';
import { detailUrl } from './detail';
import type { DetailRef } from '../types';

describe('detailUrl', () => {
  it('encodes entity ids containing ":" and "/"', () => {
    const def = { type: 'entity', kind: 'camera' } as DetailRef;
    expect(detailUrl(def, 'a:b/c')).toBe('/api/entities/camera/a%3Ab%2Fc');
  });
  it('encodes event ids', () => {
    const def = { type: 'event', source: 'mta_subway_alerts' } as DetailRef;
    expect(detailUrl(def, 'lmm:alert/1')).toBe('/api/events/mta_subway_alerts/lmm%3Aalert%2F1');
  });
  it('is null for layers without detail', () => {
    expect(detailUrl({ type: 'none' } as DetailRef, 'x')).toBeNull();
  });
});
