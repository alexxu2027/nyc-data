import { describe, expect, it } from 'vitest';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { BUILDINGS_3D, OMT_SOURCE, postProcess, SHADOW } from './basemap';
import { sunLines } from './Controls';
import { sunLight } from './scene';
import { LIGHT_TOKENS } from './styleToPaint';

const NYC = { lat: 40.7128, lng: -74.006 };

describe('scene layers in the basemap (ADR-017)', () => {
  const style = (layers: Array<Partial<LayerSpecification> & { id: string; type: string }>): StyleSpecification =>
    ({ version: 8, sources: { [OMT_SOURCE]: { type: 'vector', url: 'x' } }, layers }) as StyleSpecification;

  it('go after the last non-label layer (above roads), hidden, with the shadow image source', () => {
    // Like the dark style: a water label comes before the buildings and roads.
    const out = postProcess(
      style([
        { id: 'background', type: 'background' },
        { id: 'water_name', type: 'symbol', layout: { 'text-field': 'x' } },
        { id: 'building', type: 'fill', paint: {} },
        { id: 'road', type: 'line' },
        { id: 'place_city', type: 'symbol', layout: { 'text-field': 'x' } },
      ] as never),
      'light',
      LIGHT_TOKENS,
    );
    expect(out.layers.map((l) => l.id)).toEqual(['background', 'water_name', 'building', 'road', SHADOW, BUILDINGS_3D, 'place_city']);
    for (const id of [SHADOW, BUILDINGS_3D]) {
      expect((out.layers.find((l) => l.id === id) as { layout: Record<string, unknown> }).layout.visibility).toBe('none');
    }
    expect(out.sources[SHADOW]).toMatchObject({ type: 'image' });
  });

  it('are left out of a style without the OpenMapTiles source (offline fallback)', () => {
    const out = postProcess({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] } as StyleSpecification, 'light', LIGHT_TOKENS);
    expect(out.layers.map((l) => l.id)).toEqual(['background']);
  });
});

describe('sunLight', () => {
  it('points the style light at the sun: azimuth, and 90° minus its height', () => {
    expect(sunLight({ azimuth: 200, altitude: 30 })).toMatchObject({ anchor: 'map', position: [1.5, 200, 60] });
    expect(sunLight({ azimuth: 90, altitude: -5 }).intensity).toBeLessThan(0.3);
  });
});

describe('sun readout', () => {
  it('in the afternoon: height, direction, sunset; asks to zoom in for shadows', () => {
    const l = sunLines(Date.parse('2026-11-17T19:00:00Z'), NYC.lat, NYC.lng, 13); // 2 PM ET
    expect(l[0]).toMatch(/^SUN \d+° UP · (S|SW)$/);
    expect(l[1]).toMatch(/^SETS 4:3\d PM ET$/);
    expect(l[2]).toBe('ZOOM IN FOR SHADOWS');
    expect(sunLines(Date.parse('2026-11-17T19:00:00Z'), NYC.lat, NYC.lng, 16)).toHaveLength(2);
  });

  it("at night: down, and tomorrow's sunrise", () => {
    expect(sunLines(Date.parse('2026-11-18T03:00:00Z'), NYC.lat, NYC.lng, 16)).toEqual(['SUN DOWN', expect.stringMatching(/^RISES 6:4\d AM ET$/)]);
  });

  it("before dawn: today's sunrise", () => {
    expect(sunLines(Date.parse('2026-11-17T10:00:00Z'), NYC.lat, NYC.lng, 16)[1]).toMatch(/^RISES 6:4\d AM ET$/);
  });
});

describe('map workers', () => {
  it('half the cores, 2 to 4 (MapLibre 6 defaults to 1 outside Safari)', async () => {
    const { workerCountFor } = await import('./controller');
    expect(workerCountFor(2)).toBe(2);
    expect(workerCountFor(8)).toBe(4);
    expect(workerCountFor(12)).toBe(4);
    expect(workerCountFor(6)).toBe(3);
    expect(workerCountFor(undefined)).toBe(2);
  });
});

describe('light mode: the basemap whites are dimmed (2026-11-17)', () => {
  it('white becomes the warm off-white, black stays black, alpha kept; non-colours pass', async () => {
    const { dimColor, LIGHT_WHITE, parseColor } = await import('./basemap');
    expect(dimColor('#fff')).toBe(`rgba(${LIGHT_WHITE.join(',')},1)`);
    expect(dimColor('#000')).toBe('rgba(0,0,0,1)');
    expect(dimColor('rgba(255,255,255,0.7)')).toBe(`rgba(${LIGHT_WHITE.join(',')},0.7)`);
    expect(parseColor('hsl(0,0%,88%)')!.slice(0, 3).map(Math.round)).toEqual([224, 224, 224]);
    expect(dimColor('class')).toBe('class'); // a match key inside an expression
  });

  it('postProcess dims colours in light mode only, inside expressions too', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: 'road', type: 'line', paint: { 'line-color': ['match', ['get', 'class'], 'motorway', '#fff', '#fafafa'], 'line-width': 2 } }],
    } as unknown as StyleSpecification;
    const light = postProcess(style, 'light', LIGHT_TOKENS).layers[0] as { paint: Record<string, unknown> };
    expect(JSON.stringify(light.paint['line-color'])).not.toContain('#fff');
    expect(light.paint['line-width']).toBe(2);
    const dark = postProcess(style, 'dark', LIGHT_TOKENS).layers[0] as { paint: Record<string, unknown> };
    expect(JSON.stringify(dark.paint['line-color'])).toContain('#fff');
  });
});
