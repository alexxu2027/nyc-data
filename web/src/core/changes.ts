// Which feature ids changed between two polls of a layer (ADR-013 item 4). poll.ts calls it on
// every 200; the map flashes a ring on the result (map/changePulse.ts).
//
// - Only layers with a catalog `changes` entry ever report changes.
// - The first load reports nothing: every dot would flash and none of it is news.
// - A feature counts when one of `changes.props` differs from the previous poll, or (with
//   `changes.new`) when its id was not in the previous poll. Other props never count, so a
//   bike count ticking from 7 to 6 is not a change; a station going "ok" -> "empty" is.
import type { LayerDef, LayerFeature } from '../types';

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function changedIds(def: LayerDef, prev: LayerFeature[], next: LayerFeature[], first: boolean): string[] {
  const spec = def.changes;
  if (!spec || first) return [];
  const before = new Map<string, LayerFeature['properties']>();
  for (const f of prev) before.set(String(f.properties.id), f.properties);
  const out: string[] = [];
  for (const f of next) {
    const id = String(f.properties.id);
    const p = before.get(id);
    if (!p) {
      if (spec.new) out.push(id);
      continue;
    }
    if (spec.props.some((k) => !same(p[k], f.properties[k]))) out.push(id);
  }
  return out;
}
