import { describe, expect, it } from 'vitest';
import { featureTitle } from '../drawer/detail';
import { headsignOnly } from '../core/bus';
import { airReadout } from '../drawer/views/entity';
import { tooltipText } from './tooltipText';

const BUS = {
  route: 'M15+',
  service: 'sbs',
  service_name: 'Select Bus Service',
  headsign: 'SELECT BUS SERVICE SOUTH FERRY via 2 AV',
  next_name: '2 AV/E 23 ST',
};

describe('buses (ADR-018)', () => {
  it('tooltip: route, destination, next stop, service when not local', () => {
    expect(tooltipText('buses', BUS)).toEqual({
      title: 'M15+ bus',
      lines: ['To SOUTH FERRY via 2 AV', 'Next: 2 AV/E 23 ST', 'Select Bus Service'],
    });
    expect(tooltipText('buses', { ...BUS, route: 'B41', service: 'local', service_name: 'Local' }).lines).toHaveLength(2);
  });
  it('is titled as a bus, never a train', () => {
    expect(featureTitle(BUS, 'x')).toBe('M15+ bus to SOUTH FERRY via 2 AV');
    expect(featureTitle({ route: 'F', next_name: 'Jay St', headsign: 'Coney Island' }, 'x')).toBe('F train to Coney Island');
  });
  it('drops the Select Bus prefix from the destination row', () => {
    expect(headsignOnly('SELECT BUS SERVICE SOUTH FERRY via 2 AV')).toBe('SOUTH FERRY via 2 AV');
    expect(headsignOnly('SELECT BUS JAMAICA via MAIN ST')).toBe('JAMAICA via MAIN ST');
    expect(headsignOnly('MIDTOWN  32 ST & 5 AV')).toBe('MIDTOWN 32 ST & 5 AV');
    expect(headsignOnly(null)).toBeNull();
  });
});

describe('air quality (ADR-018)', () => {
  it('tooltip: PM2.5 and category, or no reading; and the station type', () => {
    expect(tooltipText('air_quality', { name: 'CCNY', pm25: 4.5, live: true, category_name: 'Good', monitor: true })).toEqual({
      title: 'CCNY',
      lines: ['PM2.5 4.5 µg/m³ · Good', 'Government monitor'],
    });
    expect(tooltipText('air_quality', { name: 'Win Son', pm25: 20, live: false, monitor: false }).lines).toEqual([
      'No reading in 3 h',
      'Low-cost sensor',
    ]);
  });
  it('readout: value with category and AQI, a stale value, or none', () => {
    expect(airReadout(12.3, true, 'Moderate', 57)).toEqual({ k: 'PM2.5', v: '12.3 µG/M³', r: 'MODERATE · AQI 57' });
    expect(airReadout(12.3, false, null, null)).toEqual({ k: 'PM2.5', v: 'NO READING IN 3 H', r: 'LAST 12.3 µG/M³' });
    expect(airReadout(null, false, null, null).v).toBe('--');
  });
});
