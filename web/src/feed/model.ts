// Pure pieces of the "what changed" feed (ADR-013 item 4): unread counts, row text and what a
// click on an item does. No React, no DOM.
import type { AppState } from '../core';
import type { ChangeItem } from '../types';

export const KIND_LABEL: Record<ChangeItem['kind'], string> = {
  weather: 'WEATHER',
  alert: 'ALERT',
  outage: 'OUTAGE',
  flood: 'FLOOD',
};

/** Feature zoom for a click: never zoom out, at least street level. */
export const ITEM_ZOOM = 14;

const atMs = (it: ChangeItem): number => {
  const t = Date.parse(it.at);
  return Number.isFinite(t) ? t : 0;
};

/** NEW = first seen after the reader last looked at the feed. */
export function isNew(it: ChangeItem, seenAt: number): boolean {
  return atMs(it) > seenAt;
}

export function unreadCount(items: ChangeItem[], seenAt: number): number {
  let n = 0;
  for (const it of items) if (isNew(it, seenAt)) n += 1;
  return n;
}

/** The newest `at` in ms (0 for none): what "seen up to" means after reading the list. */
export function newestAt(items: ChangeItem[]): number {
  let m = 0;
  for (const it of items) m = Math.max(m, atMs(it));
  return m;
}

/** Same rows in the same order (the body's `now` changes every rebuild; the rows rarely do). */
export function sameItems(a: ChangeItem[], b: ChangeItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.at !== y.at || x.ended !== y.ended || x.title !== y.title || x.severity !== y.severity ||
      x.feature !== y.feature || x.lat !== y.lat || x.lon !== y.lon) return false;
  }
  return true;
}

/** "ALERT A trains delayed" (the time goes in its own column). */
export function itemText(it: ChangeItem): string {
  return `${KIND_LABEL[it.kind] ?? it.kind.toUpperCase()} ${it.title}`;
}

export type OpenResult = 'feature' | 'list' | 'fly' | 'none';

type OpenStore = Pick<AppState, 'catalog' | 'view' | 'setLayerVisible' | 'flyTo' | 'select'>;

/**
 * A click on an item: show its layer, fly to it (zoom max(current, 14)), then open the drawer on
 * its feature. No feature: the layer's list when it has one, else just the fly.
 */
export function openItem(it: ChangeItem, st: OpenStore): OpenResult {
  const def = st.catalog?.layers.find((l) => l.id === it.layer);
  if (!def) return 'none';
  st.setLayerVisible(it.layer, true);
  if (it.lat !== null && it.lon !== null) st.flyTo({ lng: it.lon, lat: it.lat, zoom: Math.max(st.view.zoom, ITEM_ZOOM) });
  if (it.feature !== null) {
    st.select({ mode: 'feature', layer: it.layer, id: it.feature });
    return 'feature';
  }
  if (def.list) {
    st.select({ mode: 'list', layer: it.layer });
    return 'list';
  }
  return it.lat !== null && it.lon !== null ? 'fly' : 'none';
}
