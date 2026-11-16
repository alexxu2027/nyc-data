// Text-only hover tooltip (plan §7.3): a small printed slip with a hard offset shadow.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useApp } from '../core';
import type { MapController } from './controller';
import { tooltipText } from './tooltipText';

const GAP = 14;

export function Tooltip({ ctl }: { ctl: MapController }) {
  const info = useSyncExternalStore(ctl.tooltip.subscribe, ctl.tooltip.get, ctl.tooltip.get);
  const def = useApp((s) => (info ? s.catalog?.layers.find((l) => l.id === info.layer) : undefined));
  const ref = useRef<HTMLDivElement>(null);

  // Flip to stay inside the map: right of and below the pointer unless that would clip.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!info || !el) return;
    const box = ctl.map.getContainer();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = info.x + GAP;
    let top = info.y + GAP;
    if (left + w > box.clientWidth - 4) left = Math.max(4, info.x - GAP - w);
    if (top + h > box.clientHeight - 4) top = Math.max(4, info.y - GAP - h);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }, [info, ctl]);

  if (!info) return null;
  const t = tooltipText(info.layer, info.props, def);
  return (
    <div
      ref={ref}
      className="nl-tip"
      role="tooltip"
      style={{ left: info.x + GAP, top: info.y + GAP, visibility: 'hidden' }}
    >
      <div className="nl-tip-k">{def?.short ?? info.layer}</div>
      <div className="nl-tip-t">{t.title}</div>
      {t.lines.map((l, i) => (
        <div key={i} className="nl-tip-l">
          {l}
        </div>
      ))}
      {/* Say it can be clicked (UX review B14); cameras already say so in their own line. */}
      {info.layer !== 'cameras' && <div className="nl-tip-l nl-tip-hint">CLICK FOR DETAIL</div>}
    </div>
  );
}
