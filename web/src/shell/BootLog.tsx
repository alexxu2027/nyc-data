// The boot log: once per visit, when the first /api/health answer arrives, the feed check
// prints line by line in a small inverted panel over the map's bottom-right corner, holds, then
// rolls up into the "N OF M FEEDS OK" readout below it. Desktop only. Skipped under reduced
// motion (the status line already shows the finished state), in a hidden tab, or if health
// takes longer than BOOT_WAIT_MS (it would no longer read as "starting up").
import { useEffect, useState, type CSSProperties } from 'react';
import { useApp } from '../core';
import type { Health } from '../types';
import { FreshDot, Line, Panel, PRINT_MAX_STAGGER, PRINT_STAGGER_MS, useReducedMotion } from '../ui';
import { sortSources } from './helpers';

export const BOOT_KEY = 'nyclive.boot';
export const BOOT_WAIT_MS = 8000;
/** How long the finished log stays up before it rolls away. */
export const BOOT_HOLD_MS = 900;
/** The roll-up (styles/motion.css .boot-log: 0.2s). */
export const ROLL_MS = 200;

const STATE_WORD: Record<string, string> = { ok: 'OK', stale: 'STALE', degraded: 'FAILING', never: 'NO DATA' };

/** "CITI BIKE STATION STATUS" from "Citi Bike station status (GBFS)": the log is one line each. */
export function shortName(name: string): string {
  return name.replace(/\s*\(.*$/, '').toUpperCase();
}

function alreadyBooted(): boolean {
  try {
    return sessionStorage.getItem(BOOT_KEY) === '1';
  } catch {
    return false;
  }
}

function markBooted(): void {
  try {
    sessionStorage.setItem(BOOT_KEY, '1');
  } catch {
    /* blocked storage: it may show again next load, which is harmless */
  }
}

export function BootLog() {
  const reduced = useReducedMotion();
  const health = useApp((s) => s.health);
  const [shown, setShown] = useState<Health | null>(null);
  const [done, setDone] = useState(() => alreadyBooted());
  const [late, setLate] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setLate(true), BOOT_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // The first health answer decides, once (state adjusted during render, not in an effect).
  if (!done && !shown && health) {
    if (reduced || late || (typeof document !== 'undefined' && document.hidden)) setDone(true);
    else setShown(health);
  }
  const decided = done || shown !== null;
  useEffect(() => {
    if (decided) markBooted();
  }, [decided]);

  // Gone once it has printed, held and rolled up (a timer, so it also goes if the browser
  // never runs the animation).
  const rows = shown ? shown.sources.length + 1 : 0;
  const printMs = Math.min(rows, PRINT_MAX_STAGGER + 1) * PRINT_STAGGER_MS + 160;
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setDone(true), printMs + BOOT_HOLD_MS + ROLL_MS + 50);
    return () => clearTimeout(t);
  }, [shown, printMs]);

  useEffect(() => {
    if (!shown) return;
    const onHide = () => document.hidden && setDone(true);
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [shown]);

  if (done || !shown) return null;
  const sources = sortSources(shown.sources);
  const s = shown.summary;
  const delay = (i: number): CSSProperties => ({ animationDelay: `${Math.min(i, PRINT_MAX_STAGGER) * PRINT_STAGGER_MS}ms` });
  return (
    <div
      className="sh-bootlog boot-log"
      aria-hidden="true"
      style={{ '--boot-hold': `${printMs + BOOT_HOLD_MS}ms` } as CSSProperties}
    >
      <Panel tone="ink" numbered title="FEED CHECK">
        {sources.map((src, i) => (
          <div key={src.id} className="print-row" style={delay(i)}>
            <Line nowrap right={<span className="num">{STATE_WORD[src.state] ?? src.state.toUpperCase()}</span>}>
              <FreshDot state={src.state} /> {shortName(src.name)}
            </Line>
          </div>
        ))}
        <div className="print-row" style={delay(sources.length)}>
          <Line nowrap>
            {s.ok} OF {sources.length} FEEDS OK
          </Line>
        </div>
      </Panel>
    </div>
  );
}
