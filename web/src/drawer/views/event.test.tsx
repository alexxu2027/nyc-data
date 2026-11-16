import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KIND_LABEL } from '../../feed/model';
import { RENDERERS } from '../../map/layers';
import type { EventDetail } from '../../types';
import { EventView } from './event';

afterEach(cleanup);

const detail = (props: Record<string, unknown>): EventDetail =>
  ({
    source: 'notify_nyc', id: '900020', category: 'city_alert', subtype: 'Traffic Delays',
    title: 'Update: Traffic Delays - FDR Drive (MN)', starts_at: '2026-11-16T21:00:00Z',
    ends_at: '2026-11-16T23:00:00Z', severity: 2, status: 'active', lat: null, lon: null,
    borough: 'MN', routes: [], stations: [], props, geometry: null, entity_refs: [], entities: [],
  }) as EventDetail;

describe('Notify NYC in the UI (ADR-015)', () => {
  it('CapView shows severity, the update note, area and readable text', () => {
    render(
      <EventView
        source="notify_nyc"
        id="900020"
        props={undefined}
        detail={detail({ severity: 'Moderate', urgency: 'Immediate', msg_type: 'Update', area_desc: 'New York', description: 'Take the [shuttle bus icon].' })}
      />,
    );
    expect(screen.getByText('MODERATE')).toBeTruthy();
    expect(screen.getByText('UPDATES AN EARLIER ALERT')).toBeTruthy();
    expect(screen.getByText('NYC EMERGENCY MANAGEMENT')).toBeTruthy();
    expect(screen.getByText('Take the [BUS].')).toBeTruthy();
  });

  it('a citywide alert says it is not drawn', () => {
    render(<EventView source="notify_nyc" id="x" props={undefined} detail={detail({ citywide: true })} />);
    expect(screen.getByText('CITYWIDE: NOT DRAWN ON THE MAP')).toBeTruthy();
  });

  it('the layer uses the alert polygons renderer, and CHANGES labels notices CITY', () => {
    expect(RENDERERS.city_alerts).toBe(RENDERERS.nws_alerts);
    expect(KIND_LABEL.notice).toBe('CITY');
  });
});
