// STUB (wave 0). Owned by U4.
import type { ReactNode } from 'react';

export function Shell({ map, drawer }: { map: ReactNode; drawer: ReactNode }) {
  return (
    <div style={{ height: '100%', position: 'relative' }}>
      {map}
      {drawer}
    </div>
  );
}
