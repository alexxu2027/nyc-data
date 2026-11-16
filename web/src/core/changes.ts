// Which feature ids changed between two polls of a layer (ADR-013 item 4).
// Stub from Phase 2.5 U0: always empty. U4 fills it in.
import type { LayerDef, LayerFeature } from '../types';

export function changedIds(_def: LayerDef, _prev: LayerFeature[], _next: LayerFeature[], _first: boolean): string[] {
  return [];
}
