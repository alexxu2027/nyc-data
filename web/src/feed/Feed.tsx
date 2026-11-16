// The "what changed" list and its one-line ticker (ADR-013 item 4). The shell places them: the
// list in the CHANGES panel (desktop: floating bottom-left; phone: a dialog), the ticker in the
// status line.
import { useEffect, useState } from 'react';
import { fmtTime, useApp } from '../core';
import type { ChangeItem } from '../types';
import { Banner, Line } from '../ui';
import { isNew, itemText, KIND_LABEL, newestAt, openItem, unreadCount } from './model';
import './feed.css';

/** "3:21 PM" (the panel says the times are ET). */
const hhmm = (iso: string) => fmtTime(iso).replace(/ ET$/, '');

/** Unread items (first seen after the reader last opened the list). */
export function useUnread(): number {
  return useApp((s) => unreadCount(s.feed.items, s.feed.seenAt));
}

function Row({ it, fresh, onOpen }: { it: ChangeItem; fresh: boolean; onOpen: (it: ChangeItem) => void }) {
  const where = it.feature !== null || it.lat !== null ? '' : ' (not on the map)';
  return (
    <Line
      nowrap
      onClick={() => onOpen(it)}
      title={`${fmtTime(it.at, 'datetime')}: ${itemText(it)}${it.ended ? ' (ended)' : ''}${where}`}
      right={<span className="num muted">{hhmm(it.at)}</span>}
    >
      <span className={fresh ? 'fd-mark' : 'fd-mark off'} aria-label={fresh ? 'New: ' : undefined}>
        {fresh ? '*' : ' '}
      </span>
      <span className="fd-kind">{KIND_LABEL[it.kind] ?? it.kind.toUpperCase()}</span>
      <span className={it.ended ? 'fd-title ended' : 'fd-title'}>
        {it.title}
        {it.ended ? ' (ENDED)' : ''}
      </span>
    </Line>
  );
}

/**
 * The list. Items marked * arrived since the list was last opened; opening it (and new items
 * arriving while it is open) moves `feed.seenAt` up to the newest item.
 */
export function FeedBody({ onOpened }: { onOpened?: () => void }) {
  const feed = useApp((s) => s.feed);
  const [markFrom] = useState(() => useApp.getState().feed.seenAt);
  useEffect(() => {
    const n = newestAt(feed.items);
    if (n > useApp.getState().feed.seenAt) useApp.setState((s) => ({ feed: { ...s.feed, seenAt: n } }));
  }, [feed.items]);

  const open = (it: ChangeItem) => {
    openItem(it, useApp.getState());
    onOpened?.();
  };

  const loading = feed.fetchedAt === null && feed.status !== 'error';
  return (
    <>
      <Line muted right="TIMES ET">
        LAST 12 H
      </Line>
      {feed.status === 'error' && (
        <Line>
          <Banner tone="warn">{feed.items.length ? 'UPDATE FAILED, SHOWING OLDER LIST' : 'COULD NOT LOAD CHANGES'}</Banner>
        </Line>
      )}
      {loading && (
        <Line muted>
          <span className="sh-dots">LOADING</span>
        </Line>
      )}
      {!loading && !feed.items.length && feed.status !== 'error' && <Line muted>NOTHING NEW IN THE LAST 12 H.</Line>}
      <div className="fd-list" role="list" aria-label="Changes, newest first">
        {feed.items.map((it) => (
          <div role="listitem" key={it.id}>
            <Row it={it} fresh={isNew(it, markFrom)} onOpen={open} />
          </div>
        ))}
      </div>
    </>
  );
}

/** One line: the newest change. A click toggles the CHANGES panel. Nothing until the first load. */
export function FeedTicker() {
  const items = useApp((s) => s.feed.items);
  const status = useApp((s) => s.feed.status);
  const fetched = useApp((s) => s.feed.fetchedAt !== null);
  const panel = useApp((s) => s.panel);
  const setPanel = useApp((s) => s.setPanel);
  const unread = useUnread();
  const it = items[0];
  let text: string | null = null;
  if (it) text = `${hhmm(it.at)} ${itemText(it)}${it.ended ? ' (ENDED)' : ''}`;
  else if (fetched) text = 'NOTHING NEW IN 12 H';
  else if (status === 'error') text = 'CHANGES UNAVAILABLE';
  if (text === null) return null;
  return (
    <button
      type="button"
      className="fd-ticker"
      aria-pressed={panel === 'feed'}
      aria-label={`Latest change: ${text}. ${unread ? `${unread} new. ` : ''}Show all changes`}
      title={text}
      onClick={() => setPanel(panel === 'feed' ? null : 'feed')}
    >
      <span className="fd-tick-k">{unread ? '* LATEST' : 'LATEST'}</span> <span className="fd-tick-t">{text}</span>
    </button>
  );
}
