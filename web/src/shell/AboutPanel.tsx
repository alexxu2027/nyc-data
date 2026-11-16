// About: what this is, the house rules, every layer's attribution and the basemap credit.
import { useMemo } from 'react';
import { useApp } from '../core';
import { Blank, Line, Rule, TextButton } from '../ui';
import { groupLayers } from './helpers';

const BASEMAP: Array<{ text: string; url: string }> = [
  { text: 'OpenFreeMap', url: 'https://openfreemap.org/' },
  { text: '© OpenMapTiles', url: 'https://www.openmaptiles.org/' },
  { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
];

export function AboutBody() {
  const catalog = useApp((s) => s.catalog);
  const groups = useMemo(() => (catalog ? groupLayers(catalog) : []), [catalog]);
  return (
    <>
      <Line>
        NYC Live puts New York City's public live feeds on one map: bikes, trains, streets, water,
        weather and city services, refreshed while you watch.
      </Line>
      <Blank />
      <Line muted>HOW TO READ THE MAP</Line>
      <Line>CLICK A DOT, LINE OR LABEL FOR ITS DETAIL. ESC CLOSES IT.</Line>
      <Line>[X] SHOWS A LAYER. THE NUMBER BESIDE IT IS HOW MANY ARE ON THE MAP NOW.</Line>
      <Line>[+] OPENS A LAYER'S COLOUR KEY, FILTERS, TIMES AND SOURCE.</Line>
      <Line>THE DOT BESIDE A LAYER SAYS HOW CURRENT ITS FEED IS: ● FRESH ◐ STALE ✕ FAILING ◌ NO DATA YET.</Line>
      <Line>CHANGES LISTS NEW ALERTS, OUTAGES AND FLOODS FROM THE LAST 12 H.</Line>
      <Line>LIVE: THE MAP REFRESHES BY ITSELF. NOTHING TO RELOAD.</Line>
      <Blank />
      <Line muted>HOUSE RULES</Line>
      <Line>NO KEYS AND NO ACCOUNTS: EVERY FEED IS PUBLIC AND KEYLESS.</Line>
      <Line>TIMES ARE NEW YORK TIME (ET). DATA IS STORED IN UTC.</Line>
      <Line>SOME FEEDS PUBLISH LATE. EACH LAYER SAYS HOW LATE AND SHOWS ITS "AS OF" TIME.</Line>
      <Line>A CAMERA FRAME LOADS ONLY FOR THE CAMERA YOU OPEN.</Line>
      <Line>THE ADDRESS BAR HOLDS THE WHOLE VIEW: COPY IT TO SHARE EXACTLY WHAT YOU SEE.</Line>
      <Blank />
      <Rule />
      <Blank />
      <Line muted>SOURCES</Line>
      {!catalog && <Line muted>LOADING THE LAYER CATALOG</Line>}
      {groups.map((g) =>
        g.layers.map((l) => (
          <div key={l.id}>
            <Line>{l.label.toUpperCase()}</Line>
            <Line indent={2} muted>
              <a href={l.attribution.url} target="_blank" rel="noreferrer">
                {l.attribution.text}
              </a>
            </Line>
          </div>
        )),
      )}
      <Line>BASEMAP</Line>
      <Line indent={2} muted>
        {BASEMAP.map((b, i) => (
          <span key={b.url}>
            {i > 0 && ', '}
            <a href={b.url} target="_blank" rel="noreferrer">
              {b.text}
            </a>
          </span>
        ))}
      </Line>
      <Blank />
      <Line muted>KEYS: TAB MOVES THROUGH EVERY CONTROL. ESC CLOSES THIS PANEL.</Line>
      <ThemeLine />
    </>
  );
}

/** The theme toggle (the top bar has it on desktop; on phone it lives only here). */
function ThemeLine() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Line muted>
      THEME:{' '}
      <TextButton pressed={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} ariaLabel="Dark theme">
        DARK
      </TextButton>
    </Line>
  );
}
