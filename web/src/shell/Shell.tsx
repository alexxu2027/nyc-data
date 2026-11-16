// The app shell (U4, plan §7.2). Owns layout: top bar, layer panel, map slot, drawer slot,
// status line, health and about panels, boot error, phone sheets, and the map insets.
// Talks to the map and the drawer only through the store.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../core';
import { FeedBody, startFeedPolling } from '../feed';
import type { Selection } from '../types';
import { Banner, Line, Panel, Sheet, TextButton, useIsPhone, FreshDot, type Detent } from '../ui';
import { AboutBody } from './AboutPanel';
import { Dialog } from './Dialog';
import { HealthBody } from './HealthPanel';
import { LayerPanelBody } from './LayerPanel';
import { StatusLine } from './StatusLine';
import { TopBar } from './TopBar';
import './shell.css';

export interface ShellProps {
  map: ReactNode;
  drawer: ReactNode;
}

/** Gap between the floating drawer and the map edges, in px (also part of the right inset). */
const DRAWER_GAP = 12;

function selectionKey(s: Selection): string {
  if (!s) return '';
  return s.mode === 'list' ? `list:${s.layer}` : `f:${s.layer}:${s.id}`;
}

export function Shell({ map, drawer }: ShellProps) {
  const isPhone = useIsPhone();
  const selection = useApp((s) => s.selection);
  const panel = useApp((s) => s.panel);
  const setPanel = useApp((s) => s.setPanel);
  const setInsets = useApp((s) => s.setInsets);
  const bootError = useApp((s) => s.bootError);
  const catalog = useApp((s) => s.catalog);
  const selLabel = useApp((s) => {
    const sel = s.selection;
    const def = sel ? s.catalog?.layers.find((l) => l.id === sel.layer) : undefined;
    if (!sel) return '';
    const name = (def?.short ?? sel.layer).toUpperCase();
    return sel.mode === 'list' ? `LIST: ${name}` : name;
  });

  // Rows expanded in the layer panel (kept here so they survive the phone/desktop switch).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onExpand = useCallback((id: string, open: boolean) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Phone sheets: the layer sheet starts at peek so the map shows; the drawer sheet opens at
  // half for every new selection.
  const [layerDetent, setLayerDetent] = useState<Detent>('peek');
  const selKey = selectionKey(selection);
  const [drawerDetent, setDrawerDetent] = useState<{ key: string; d: Detent }>({ key: '', d: 'half' });
  const drawerD: Detent = drawerDetent.key === selKey ? drawerDetent.d : 'half';

  // ---- Insets: what the overlays cover, for map controls and flyTo padding --------------
  const [drawerW, setDrawerW] = useState(0);
  const [layerSheetH, setLayerSheetH] = useState(0);
  const [drawerSheetH, setDrawerSheetH] = useState(0);
  const drawerRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const report = () => setDrawerW(el.getBoundingClientRect().width);
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const open = selection !== null;
  useEffect(() => {
    if (isPhone) {
      const bottom = Math.max(layerSheetH, open ? drawerSheetH : 0);
      setInsets({ top: 0, right: 0, bottom: Math.round(bottom), left: 0 });
    } else {
      setInsets({ top: 0, right: open ? Math.round(drawerW + DRAWER_GAP) : 0, bottom: 0, left: 0 });
    }
  }, [isPhone, open, drawerW, layerSheetH, drawerSheetH, setInsets]);

  // The "what changed" feed polls for the whole session (it waits for the map's first answer).
  useEffect(() => startFeedPolling(), []);

  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  const dialog =
    panel === 'feed' ? (
      // Desktop: floating bottom-left over the map, not modal. Phone: a dialog that closes
      // when an item opens, so the detail sheet shows.
      <Dialog title="CHANGES" onClose={closePanel} className="sh-feed">
        <FeedBody onOpened={isPhone ? closePanel : undefined} />
      </Dialog>
    ) : panel === 'health' ? (
      <Dialog title="FEED HEALTH" onClose={closePanel} className="sh-health">
        <HealthBody />
      </Dialog>
    ) : panel === 'about' ? (
      <Dialog title="ABOUT NYC LIVE" onClose={closePanel} className="sh-about">
        <AboutBody />
      </Dialog>
    ) : null;

  // The tree keeps the map slot at the same position in every layout, so switching between
  // phone and desktop never remounts the map.
  return (
    <div className={isPhone ? 'shell phone' : 'shell'}>
      <TopBar />
      <div className="sh-main">
        {!isPhone && (
          <aside className="sh-side" aria-label="Layers">
            <Panel title="LAYERS" numbered footer={<FreshLegend />}>
              <LayerPanelBody expanded={expanded} onExpand={onExpand} />
            </Panel>
          </aside>
        )}
        <main className="sh-map" aria-label="Map">
          {map}
          {bootError && !catalog && <BootError message={bootError} />}
          {!isPhone && open && (
            <div ref={drawerRef} className="sh-drawer float deal" aria-label={`Detail: ${selLabel}`} role="region">
              {drawer}
            </div>
          )}
          {!isPhone && dialog}
        </main>
      </div>
      {!isPhone && <StatusLine />}
      {isPhone && (
        <>
          <Sheet
            open
            detent={layerDetent}
            onDetent={setLayerDetent}
            title={<PhoneTitle />}
            onHeight={setLayerSheetH}
          >
            <StatusLine compact />
            <Panel numbered footer={<FreshLegend />}>
              <LayerPanelBody expanded={expanded} onExpand={onExpand} />
            </Panel>
          </Sheet>
          <Sheet
            open={open}
            detent={drawerD}
            onDetent={(d) => setDrawerDetent({ key: selKey, d })}
            title={selLabel || 'DETAIL'}
            onHeight={setDrawerSheetH}
          >
            {open && <div className="sh-drawer-sheet">{drawer}</div>}
          </Sheet>
          {dialog}
        </>
      )}
    </div>
  );
}

/** The phone layer sheet's title: a compact status ("LAYERS 6 ON"). */
function PhoneTitle() {
  const on = useApp((s) => s.visible.length);
  const catalog = useApp((s) => s.catalog);
  return <>LAYERS {catalog ? `${on} ON` : ''}</>;
}

/** Every symbol gets a legend: the freshness dots used on the rows. */
function FreshLegend() {
  return (
    <Line muted>
      <span className="sh-fresh-legend">
        <span>
          <FreshDot state="ok" /> FRESH
        </span>
        <span>
          <FreshDot state="stale" /> STALE
        </span>
        <span>
          <FreshDot state="degraded" /> FAILING
        </span>
        <span>
          <FreshDot state="off" /> OFF
        </span>
      </span>
    </Line>
  );
}

function BootError({ message }: { message: string }) {
  return (
    <Dialog title="NYC LIVE IS OFFLINE" className="sh-boot">
      <Line center>*** THE LAYER CATALOG DID NOT LOAD ***</Line>
      <Line>
        <Banner tone="warn">{message}</Banner>
      </Line>
      <Line muted>The map API did not answer. If you run this locally, start it with `nyclive serve`.</Line>
      <Line right={<TextButton onClick={() => location.reload()} ariaLabel="Reload the page">TRY AGAIN</TextButton>}>
        {' '}
      </Line>
    </Dialog>
  );
}
