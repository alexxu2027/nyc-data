// Swatch sample data for the Gallery (the only data colours outside Swatch.tsx).
import type { LegendItem } from '../types';

// Legends transcribed from config/layers.yaml (plan §1), so the gallery shows the real keys.
export const SAMPLE_LEGENDS: Array<{ title: string; items: LegendItem[] }> = [
  {
    title: 'Citi Bike: bikes as a share of working docks',
    items: [
      { label: 'Empty', shape: 'circle', color: '#440154' },
      { label: 'Low', shape: 'circle', color: '#3b528b' },
      { label: 'Half', shape: 'circle', color: '#21918c' },
      { label: 'Plenty', shape: 'circle', color: '#5ec962' },
      { label: 'Full', shape: 'circle', color: '#fde725' },
      { label: 'Not renting', shape: 'ring', color: '#8a8a8a' },
      { label: 'Size: dock capacity', shape: 'size' },
    ],
  },
  {
    title: 'Road speeds',
    items: [
      { label: 'Under 10 mph', shape: 'line', color: '#d73027' },
      { label: '10–20', shape: 'line', color: '#fc8d59' },
      { label: '20–35', shape: 'line', color: '#fee090' },
      { label: '35–50', shape: 'line', color: '#91bfdb' },
      { label: '50+', shape: 'line', color: '#4575b4' },
      { label: 'No reading', shape: 'dash', color: '#9a9a9a' },
      { label: 'Faded: reading older than 3 h', shape: 'text' },
    ],
  },
  {
    title: 'NWS alerts',
    items: [
      { label: 'Severe/Extreme', shape: 'fill', color: '#d55e00' },
      { label: 'Moderate', shape: 'fill', color: '#e69f00' },
      { label: 'Minor', shape: 'fill', color: '#f0e442' },
      { label: 'Info', shape: 'fill', color: '#9e9e9e' },
      { label: 'Upcoming', shape: 'dash', color: 'ink' },
    ],
  },
  {
    title: 'Subway alerts',
    items: [
      { label: 'Service change or delay', shape: 'circle', color: '#e69f00' },
      { label: 'Suspension', shape: 'circle', color: '#d55e00' },
      { label: 'Unplanned, in effect', shape: 'pulse', color: '#d55e00' },
      { label: 'Upcoming', shape: 'ring', color: '#e69f00' },
      { label: 'Size: alerts at station', shape: 'size', color: '#e69f00' },
    ],
  },
  {
    title: 'Markers and reference',
    items: [
      { label: 'Camera online', shape: 'glyph', glyph: 'camera', color: 'ink' },
      { label: 'Camera offline', shape: 'ring', color: 'muted' },
      { label: 'Elevator out', shape: 'glyph', glyph: 'elevator', color: '#cc79a7' },
      { label: 'Precipitation now', shape: 'glyph', glyph: 'drop' },
      { label: 'Tide gauge', shape: 'glyph', glyph: 'wave' },
      { label: 'Station alert', shape: 'glyph', glyph: 'alert', color: '#d55e00' },
      { label: 'Fatal collision', shape: 'square', color: '#5e3c99' },
      { label: 'Borough outline', shape: 'line', color: 'ink' },
      { label: 'Outside the borough filter', shape: 'fill', color: 'muted' },
    ],
  },
];
