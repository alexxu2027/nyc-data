import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventSummary } from '../../types';
import { EventItem, readableText } from './common';

afterEach(cleanup);

const ev: EventSummary = {
  source: 'mta_subway_alerts', id: 'a1', category: 'service_alert', subtype: 'Delays', title: 'A trains delayed',
  starts_at: '2026-11-16T10:00:00Z', ends_at: null, severity: 2, status: 'active', lat: 40.7, lon: -73.9,
  borough: 'MN', routes: ['A'], stations: [], props: { description: 'Take the [shuttle bus icon] instead.' },
};

describe('readableText', () => {
  it('names the MTA inline icons', () => {
    expect(readableText('[shuttle bus icon] and [accessibility icon]')).toBe('[BUS] and [ACCESSIBLE]');
    expect(readableText('Use the [airplane icon] stop')).toBe('Use the [AIRPLANE] stop');
    expect(readableText('[A] trains')).toBe('[A] trains');
  });
});

describe('EventItem collapsible (UX review B13)', () => {
  it('folds the text behind MORE and opens it', () => {
    render(<EventItem ev={ev} collapsible />);
    expect(screen.queryByText(/Take the/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show the text/ }));
    expect(screen.getByText('Take the [BUS] instead.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Hide the text/ })).toBeTruthy();
  });

  it('is open by default outside lists', () => {
    render(<EventItem ev={ev} />);
    expect(screen.getByText('Take the [BUS] instead.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show the text/ })).toBeNull();
  });
});
