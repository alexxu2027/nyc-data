// Top bar: title chip, borough chips with ALL, [CHANGES (n NEW)] (desktop), [HEALTH], [ABOUT]
// and the theme toggle.
import { useApp } from '../core';
import { useUnread } from '../feed';
import type { BoroughCode, PanelId, Theme, ThemeMode } from '../types';
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
  const themeMode = useApp((s) => s.themeMode);
  const setThemeMode = useApp((s) => s.setThemeMode);
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
          {/* On phone too (UX review B11): it was the only way in, and hidden there. */}
          <TextButton
            pressed={panel === 'feed'}
            onClick={() => flip('feed')}
            ariaLabel={unread ? `Changes, ${unread} new` : 'Changes'}
          >
            <span className="full">{changesLabel(unread)}</span>
            <span className="short">{unread > 0 ? `${Math.min(unread, 99)} NEW` : 'CHANGES'}</span>
          </TextButton>
          <TextButton pressed={panel === 'health'} onClick={() => flip('health')} ariaLabel="Feed health">
            <>
              <FreshDot state={healthDot} /> HEALTH
            </>
          </TextButton>
          <TextButton pressed={panel === 'about'} onClick={() => flip('about')} ariaLabel="About and sources">
            ABOUT
          </TextButton>
          {/* Phone: the toggle lives in ABOUT, to make room for CHANGES. */}
          <span className="hide-phone">
            <TextButton
              pressed={themeMode !== 'light'}
              onClick={() => setThemeMode(nextThemeMode(themeMode))}
              ariaLabel={`Theme: ${themeMode}. Click for ${nextThemeMode(themeMode)}`}
            >
              {themeLabel(themeMode, theme)}
            </TextButton>
          </span>
        </span>
      </div>
    </header>
  );
}

/** The theme control cycles LIGHT → DARK → AUTO. */
export function nextThemeMode(m: ThemeMode): ThemeMode {
  return m === 'light' ? 'dark' : m === 'dark' ? 'auto' : 'light';
}

/** "LIGHT", "DARK", or "AUTO: DAY" / "AUTO: NIGHT". */
export function themeLabel(m: ThemeMode, shown: Theme): string {
  if (m !== 'auto') return m.toUpperCase();
  return `AUTO: ${shown === 'dark' ? 'NIGHT' : 'DAY'}`;
}
