// UI kit gallery at /?gallery=1: every primitive in light, dark and inverted, with a width ruler.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LegendItem } from '../types';
import { Banner } from './Banner';
import { Check, Chip, Radio, TextButton } from './controls';
import { FRESH_LABELS, FRESH_ORDER, FreshDot } from './FreshDot';
import { GLYPHS, glyphPath, type GlyphName } from './glyphs';
import { useIsPhone, useLineHeight, useReducedMotion } from './hooks';
import { Blank, Heading, Line, Rule } from './Line';
import { Panel } from './Panel';
import { Num, Readout } from './readout';
import { Sheet, type Detent } from './Sheet';
import { Spark } from './Spark';
import { Swatch } from './Swatch';
import { SAMPLE_LEGENDS as LEGENDS } from './Swatch.samples';

const BOROUGHS = ['ALL', 'MN', 'BK', 'QN', 'BX', 'SI'] as const;
const SERIES: Array<[number, number]> = [3, 5, 4, 8, 12, 9, 7, 11, 14, 13, 6, 2, 4, 9, 10].map((y, i) => [i * 300, y]);
const LONG =
  'Attribution: NYC DOT Real-Time Traffic Speed Data (i4gi-tjb9), a row long enough to wrap onto a second printed line.';

function useTick(ms: number): number {
  const [n, setN] = useState(2519);
  useEffect(() => {
    const id = setInterval(() => setN((v) => v + Math.round(Math.random() * 40 - 18)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

function Legend({ title, items }: { title: string; items: LegendItem[] }) {
  return (
    <>
      <Line muted>{title.toUpperCase()}</Line>
      {items.map((it) => (
        <Line key={it.label} indent>
          <Swatch shape={it.shape} color={it.color} glyph={it.glyph} /> {it.label}
        </Line>
      ))}
    </>
  );
}

function GlyphMark({ name }: { name: GlyphName }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" style={{ verticalAlign: '-0.12em' }}>
      <path d={glyphPath(name)} fill="currentColor" />
    </svg>
  );
}

function Samples({ id, label }: { id: string; label: string }) {
  const count = useTick(1000);
  const [toggle, setToggle] = useState(true);
  const [live, setLive] = useState(true);
  const [boro, setBoro] = useState<string>('ALL');
  const [checks, setChecks] = useState({ bike: true, cam: false });
  const [win, setWin] = useState('24h');
  const [clicks, setClicks] = useState(0);
  const [detent, setDetent] = useState<Detent>('half');
  const [sheetOpen, setSheetOpen] = useState(true);
  const [print, setPrint] = useState(0);
  const frame: CSSProperties = {
    position: 'relative',
    height: 'calc(var(--line) * 12)',
    overflow: 'hidden',
    transform: 'translateZ(0)', // the Sheet's fixed root anchors to this frame
  };

  return (
    <>
      <Heading exhibit="A">Lines</Heading>
      <Line right="RIGHT">LEFT, WITH A RIGHT PART</Line>
      <Line center>CENTRED</Line>
      <Line indent>INDENT 1</Line>
      <Line indent={2} muted>
        INDENT 2, MUTED
      </Line>
      <Line nowrap right={<Num value={count} />}>
        NOWRAP: {LONG}
      </Line>
      <Line>{LONG}</Line>
      <Line onClick={() => setClicks((c) => c + 1)} title="Click or press Enter" right={<Num value={clicks} width={3} />}>
        CLICKABLE ROW
      </Line>
      <Blank />
      <Rule />
      <Blank />

      <Heading exhibit="B">Chips and controls</Heading>
      <Line>
        <Chip inverted>NYC LIVE</Chip> <Chip>PLAIN</Chip>{' '}
        <Chip pressed={toggle} onClick={() => setToggle((t) => !t)} ariaLabel="Toggle chip">
          TOGGLE
        </Chip>{' '}
        <Chip href="#gallery">LINK</Chip>
      </Line>
      <div className="l">
        <span className="l-main hscroll">
          {BOROUGHS.map((b) => (
            <span key={b}>
              <Chip pressed={boro === b} onClick={() => setBoro(b)} ariaLabel={`Borough ${b}`}>
                {b}
              </Chip>{' '}
            </span>
          ))}
        </span>
      </div>
      <Line
        right={
          <>
            <TextButton pressed={live} onClick={() => setLive((v) => !v)} ariaLabel="Live">
              LIVE
            </TextButton>
            <TextButton disabled onClick={() => {}} ariaLabel="Disabled">
              OFF
            </TextButton>
            <TextButton onClick={() => {}} ariaLabel="Close">
              [CLOSE]
            </TextButton>
          </>
        }
      >
        TEXT BUTTONS
      </Line>
      <Check
        checked={checks.bike}
        onChange={(v) => setChecks((c) => ({ ...c, bike: v }))}
        label="CITI BIKE"
        right={
          <>
            <FreshDot state="ok" /> <Num value={count} /> <TextButton onClick={() => {}} ariaLabel="Expand Citi Bike">+</TextButton>
          </>
        }
      />
      <Check
        checked={checks.cam}
        onChange={(v) => setChecks((c) => ({ ...c, cam: v }))}
        label="TRAFFIC CAMERAS WITH A LABEL TOO LONG FOR THE ROW"
        right={
          <>
            <FreshDot state="stale" /> <Num value={974} />
          </>
        }
      />
      <Check checked={false} onChange={() => {}} label="DISABLED CHECK" disabled />
      <Line>
        WINDOW{' '}
        {['24h', '48h', '7d'].map((w) => (
          <Radio key={w} name={`${id}-win`} checked={win === w} onChange={() => setWin(w)} label={w.toUpperCase()} />
        ))}
      </Line>
      <Radio name={`${id}-win2`} checked={win === '24h'} onChange={() => setWin('24h')} label="STACKED: LAST 24 HOURS" />
      <Radio name={`${id}-win2`} checked={win !== '24h'} onChange={() => setWin('48h')} label="STACKED: LONGER" />
      <Blank />

      <Heading exhibit="C">Readouts</Heading>
      <Readout k="AS OF" v="3:28 AM ET" r={<Num value={count} />} />
      <Readout k="POLL" v="EVERY 60 S" r="NEXT 0:42" />
      <Readout k="NOTE" v="Feed runs 2 to 4 hours behind; this value clips instead of wrapping" />
      <Readout k="EMPTY" v={null} />
      <Readout k="BIKES 24H" v={<Spark points={SERIES} label="Bikes, last 24 hours" />} r={<Num value={14} width={3} />} />
      <Readout k="STEP" v={<Spark points={SERIES} step />} r="STEP" />
      <Readout k="ONE PT" v={<Spark points={[[0, 4]]} />} r="1" />
      <Readout k="NO DATA" v={<Spark points={[]} />} r="0" />
      <Blank />

      <Heading exhibit="D">Freshness</Heading>
      {FRESH_ORDER.map((s) => (
        <Line key={s} right={s.toUpperCase()}>
          <FreshDot state={s} /> {FRESH_LABELS[s].toUpperCase()}
        </Line>
      ))}
      <Blank />

      <Heading exhibit="E">Bands</Heading>
      <Line center>
        <Banner tone="amber">Health: 2 sources stale</Banner>
      </Line>
      <Line center>
        <Banner tone="green">Collector running</Banner>
      </Line>
      <Line center>
        <Banner tone="warn">Showing newest 20,000 of 65,799</Banner>
      </Line>
      <Blank />

      <Heading exhibit="F">Legends</Heading>
      {LEGENDS.map((g) => (
        <Legend key={g.title} {...g} />
      ))}
      <Line muted>EVERY SHAPE, NO COLOUR GIVEN</Line>
      <Line indent>
        {(['circle', 'ring', 'square', 'line', 'dash', 'fill', 'pulse', 'size'] as const).map((s) => (
          <span key={s} title={s}>
            <Swatch shape={s} />{' '}
          </span>
        ))}
      </Line>
      <Blank />

      <Heading exhibit="G">Glyphs</Heading>
      <Line>
        {(Object.keys(GLYPHS) as GlyphName[]).map((g) => (
          <span key={g}>
            <GlyphMark name={g} /> {g.toUpperCase()}{' '}
          </span>
        ))}
      </Line>
      <Blank />

      <Heading exhibit="H">Motion</Heading>
      <Line right={<TextButton onClick={() => setPrint((p) => p + 1)} ariaLabel="Print again">REPRINT</TextButton>}>
        <span key={print} className="print-in" style={{ display: 'inline-block' }}>
          PRINTED IN 8 BANDS
        </span>
      </Line>
      <Line>
        <span key={`d${count}`} className="deal" style={{ display: 'inline-block' }}>
          <Chip>DEALT ON EVERY TICK</Chip>
        </span>
      </Line>
      <Blank />

      <Heading exhibit="I">Sheet</Heading>
      <Line
        right={
          <TextButton pressed={sheetOpen} onClick={() => setSheetOpen((o) => !o)} ariaLabel="Open sheet">
            OPEN
          </TextButton>
        }
      >
        DETENT: <Num value={detent.toUpperCase()} width={4} align="left" />
      </Line>
      <div className="boxed" style={frame} aria-label={`Sheet demo, ${label}`}>
        <Sheet open={sheetOpen} detent={detent} onDetent={setDetent} title="LAYERS">
          <div style={{ padding: '0 var(--pad-x)' }}>
            {['SUBWAY ALERTS', 'CITI BIKE', 'ROAD SPEEDS', 'CAMERAS', 'FLOOD EVENTS', 'WEATHER', 'TIDE'].map((n, i) => (
              <Line key={n} right={<Num value={[235, 2519, 125, 974, 41, 5, 1][i]} />}>
                {n}
              </Line>
            ))}
          </div>
        </Sheet>
      </div>
    </>
  );
}

function Ruler() {
  const ref = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [m, setM] = useState({ vw: 0, col: 0, ch: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const chPx = (probe.current?.getBoundingClientRect().width ?? 90) / 10 || 9;
      setM({ vw: window.innerWidth, col: Math.floor(el.clientWidth / chPx), ch: chPx });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const marks = Array.from({ length: 25 }, (_, i) => String(i * 10).padEnd(10, ' ')).join('');
  const ticks = '|----+----'.repeat(25);
  const bp = m.vw <= 680 ? 'PHONE (≤ 680)' : m.vw <= 860 ? 'MID (≤ 860)' : 'DESKTOP';
  return (
    <>
      <div ref={ref} className="l divider" aria-hidden="true">
        <span style={{ whiteSpace: 'pre' }}>{marks}</span>
      </div>
      <div className="l divider" aria-hidden="true">
        <span style={{ whiteSpace: 'pre' }}>{ticks}</span>
      </div>
      <span ref={probe} className="sr-only" aria-hidden="true" style={{ width: 'auto', clipPath: 'none', visibility: 'hidden' }}>
        0000000000
      </span>
      <Readout k="VIEWPORT" v={<><Num value={m.vw} width={5} /> PX</>} r={bp} />
      <Readout k="COLUMN" v={<><Num value={m.col} width={5} /> CH</>} r={<>1 CH = <Num value={m.ch ? m.ch.toFixed(2) : '--'} width={5} /> PX</>} />
    </>
  );
}

function Column({ theme, tone, label, children }: { theme: 'light' | 'dark'; tone: 'paper' | 'ink'; label: string; children: ReactNode }) {
  return (
    <div data-theme={theme} style={{ minWidth: 0 }}>
      <Panel
        title={label}
        tone={tone}
        numbered
        className="boxed"
        footer={
          <>
            <Rule />
            <Line muted right="END">
              FOOTER, PINNED UNDER THE BODY
            </Line>
          </>
        }
      >
        <Blank />
        {children}
      </Panel>
    </div>
  );
}

export function Gallery() {
  const phone = useIsPhone();
  const reduce = useReducedMotion();
  const lh = useLineHeight();
  const grid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(48ch, 100%), 1fr))',
    gap: 'var(--line) 3ch',
    padding: '0 2ch var(--line)',
    alignItems: 'start',
  };
  return (
    <main id="gallery" style={{ minHeight: '100%', background: 'var(--paper)' }}>
      <Panel numbered>
        <Blank />
        <div className="l">
          <h1 className="panel-title">NYC LIVE</h1>
        </div>
        <Line muted>UI KIT, PLAN UNIT U2. ONE FACE, ONE WEIGHT, ONE SIZE.</Line>
        <Blank />
        <Heading exhibit="U2">The transcript kit</Heading>
        <Blank />
        <Ruler />
        <Readout k="PHONE" v={phone ? 'YES' : 'NO'} r={<>LINE <Num value={lh.toFixed(1)} width={4} /> PX</>} />
        <Readout k="MOTION" v={reduce ? 'REDUCED: STILL FRAMES' : 'STEPPED'} />
        <Blank />
        <Line muted>Light, dark and inverted columns below. Only the tokens change between them.</Line>
        <Blank />
      </Panel>
      <div style={grid}>
        <Column theme="light" tone="paper" label="LIGHT">
          <Samples id="light" label="light" />
        </Column>
        <Column theme="dark" tone="paper" label="DARK">
          <Samples id="dark" label="dark" />
        </Column>
        <Column theme="light" tone="ink" label="INVERTED">
          <Samples id="inv" label="inverted" />
        </Column>
      </div>
    </main>
  );
}
