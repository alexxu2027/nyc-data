// The one live <img> in the app: the selected camera's frame, refreshed every 3 s while the
// drawer is open and the tab is visible. The frame box is a fixed number of lines tall, so a
// refresh never moves anything below it.
import { useEffect, useRef, useState } from 'react';
import { Line, Num, Readout } from '../ui';
import { FRAME_MS, MAX_ERRORS, noSignal, startFrameLoop, type FrameState } from './camera';
import { useClock } from './hooks';

interface Shown extends FrameState {
  at: number | null;
  frames: number;
}

export function CameraFrame({ url, name, offline }: { url: string; name: string; offline: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<Shown>({ errors: 0, offline: false, paused: false, at: null, frames: 0 });
  const now = useClock();

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let stopped = false;
    const stop = startFrameLoop({
      url,
      createImage: () => {
        const img = new Image();
        img.className = 'cam-img';
        img.alt = `Live frame from ${name}`;
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        return img;
      },
      onFrame: (img, at) => {
        const show = () => {
          if (stopped) return;
          el.replaceChildren(img); // the old frame leaves the DOM: at most one <img>
          setSt((s) => ({ ...s, at, frames: s.frames + 1 }));
        };
        if (typeof img.decode === 'function') img.decode().then(show, show);
        else show();
      },
      onState: (s) => setSt((p) => (p.errors === s.errors && p.offline === s.offline && p.paused === s.paused ? p : { ...p, ...s })),
    });
    return () => {
      stopped = true;
      stop();
      el.replaceChildren();
    };
  }, [url, name]);

  const lost = noSignal(st);
  const age = st.at === null ? null : Math.max(0, Math.round((now - st.at) / 1000));
  return (
    <>
      <div className="l cam-row">
        <div className="cam" data-state={lost ? 'lost' : st.at === null ? 'tuning' : 'live'}>
          <div ref={holder} className="cam-holder" />
          {lost ? (
            <div className="cam-msg" role="status">
              <span className="cam-msg-chip">NO SIGNAL</span>
              <span className="cam-msg-sub">
                {st.offline ? 'BROWSER IS OFFLINE' : `${MAX_ERRORS} FRAMES FAILED, RETRYING`}
              </span>
            </div>
          ) : st.at === null ? (
            <div className="cam-msg" role="status">
              <span className="cam-msg-sub">TUNING IN…</span>
            </div>
          ) : null}
        </div>
      </div>
      <Readout
        k="FRAME"
        v={
          lost ? (
            'NO SIGNAL'
          ) : st.at === null ? (
            'WAITING FOR FIRST FRAME'
          ) : (
            <>
              RECEIVED <Num value={age === null ? null : `${age} s`} width={5} /> AGO
            </>
          )
        }
        r={st.paused ? 'PAUSED' : `EVERY ${FRAME_MS / 1000} S`}
      />
      {offline && <Line muted>The DOT feed lists this camera as offline.</Line>}
    </>
  );
}
