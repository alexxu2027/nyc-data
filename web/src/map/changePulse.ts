// Change pulse: rings on dots that changed on the last poll. Stub from Phase 2.5 U0 (no-ops).
// U4 implements it.
import type { Map as MlMap } from 'maplibre-gl';

export class ChangeFlash {
  constructor(_map: MlMap) {}
  setTargets(_targets: Array<{ layer: string; id: string }>): void {}
  flash(_layer: string, _ids: string[]): void {}
  destroy(): void {}
}
