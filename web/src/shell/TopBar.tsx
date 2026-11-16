// Top bar: title chip, borough chips with ALL, [CHANGES (n NEW)] (desktop), [HEALTH], [ABOUT]
// and the theme toggle.
import { useApp } from '../core';
import { useUnread } from '../feed';
import type { BoroughCode, PanelId } from '../types';
import { Chip, FreshDot, TextButton } from '../ui';
import { changesLabel, worstState } from './helpers';

const FALLBACK_BOROUGHS: Array<{ id: BoroughCode; label: string }> = [
  { id: 'MN', label: 'Manhattan' },
  { id: 'BK', label: 'Brooklyn' },
  { id: 'QN', label: 'Queens' },
  { id: 'BX', label: 'Bronx' },
  { id: 'SI', label: 'Staten Island' },
];

export function TopBar() {
  const catalogBoroughs = useApp((s) => s.catalog?.boroughs);
  const boroughs = useApp((s) => s.boroughs);
  const setBoroughs = useApp((s) => s.setBoroughs);
  const toggleBorough = useApp((s) => s.toggleBorough);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const panel = useApp((s) => s.panel);
  const setPanel = useApp((s) => s.setPanel);
  const health = useApp((s) => s.health);
  const healthError = useApp((s) => s.healthError);
  const list = catalogBoroughs ?? FALLBACK_BOROUGHS;
  const all = boroughs.length === 0;
  const flip = (p: PanelId) => setPanel(panel === p ? null : p);
  const healthDot = healthError && !health ? 'degraded' : worstState(health);
  const unread = useUnread();

  return (
    <header className="sh-top">
      <div className="sh-title l">
        <h1 className="l-main">
          <Chip inverted>NYC LIVE</Chip>
          <span className="sh-sub hide-mid muted"> LIVE OPEN DATA, ONE MAP</span>
        </h1>
      </div>
      <nav className="sh-boro l" aria-label="Borough filter">
        <span className="l-main hscroll">
          <span className="muted hide-phone">BOROUGH </span>
          <Chip pressed={all} onClick={() => setBoroughs([])} ariaLabel="All boroughs">
            ALL
          </Chip>
          {list.map((b) => (
            <span key={b.id}>
              {' '}
              <Chip pressed={boroughs.includes(b.id)} onClick={() => toggleBorough(b.id)} ariaLabel={b.label}>
                {b.id}
              </Chip>
            </span>
          ))}
        </span>
      </nav>
      <div className="sh-actions l">
        <span className="l-main">
          <span className="hide-phone">
            <TextButton
              pressed={panel === 'feed'}
              onClick={() => flip('feed')}
              ariaLabel={unread ? `Changes, ${unread} new` : 'Changes'}
            >
              {changesLabel(unread)}
            </TextButton>
          </span>
          <TextButton pressed={panel === 'health'} onClick={() => flip('health')} ariaLabel="Feed health">
            <>
              <FreshDot state={healthDot} /> HEALTH
            </>
          </TextButton>
          <TextButton pressed={panel === 'about'} onClick={() => flip('about')} ariaLabel="About and sources">
            ABOUT
          </TextButton>
          <TextButton
            pressed={theme === 'dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            ariaLabel="Dark theme"
          >
            DARK
          </TextButton>
        </span>
      </div>
    </header>
  );
}
