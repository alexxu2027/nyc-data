import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_FACTOR, FRAME_MS, FRAME_TIMEOUT_MS, MAX_ERRORS, frameUrl, noSignal, startFrameLoop, type FrameState } from './camera';

class FakeImage {
  static all: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  removed = false;
  constructor() {
    FakeImage.all.push(this);
  }
  removeAttribute(name: string) {
    if (name === 'src') {
      this.src = '';
      this.removed = true;
    }
  }
  load() {
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

const URL0 = 'https://webcams.nyctmc.org/api/cameras/abc/image';
let hidden = false;
let online = true;

function setHidden(h: boolean) {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
}

function start(extra: { onState?: (s: FrameState) => void } = {}) {
  const frames: number[] = [];
  const states: FrameState[] = [];
  const stop = startFrameLoop({
    url: URL0,
    createImage: () => new FakeImage() as unknown as HTMLImageElement,
    onFrame: (_img, at) => frames.push(at),
    onState: (s) => {
      states.push(s);
      extra.onState?.(s);
    },
  });
  return { stop, frames, states };
}

const last = () => FakeImage.all[FakeImage.all.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T18:00:00Z'));
  FakeImage.all = [];
  hidden = false;
  online = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'));
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('frameUrl', () => {
  it('appends ?t= to a bare image url', () => {
    expect(frameUrl(URL0, 1794765121000)).toBe(`${URL0}?t=1794765121000`);
  });
  it('uses &t= when the url already has a query', () => {
    expect(frameUrl('https://x/img?id=4', 5)).toBe('https://x/img?id=4&t=5');
  });
});

describe('startFrameLoop', () => {
  it('requests a cache-busted frame at once, then every 3 s', () => {
    const { stop, frames } = start();
    expect(FakeImage.all).toHaveLength(1);
    expect(last().src).toBe(`${URL0}?t=${Date.now()}`);
    last().load();
    expect(frames).toHaveLength(1);

    vi.advanceTimersByTime(FRAME_MS - 1);
    expect(FakeImage.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeImage.all).toHaveLength(2);
    expect(last().src).toBe(`${URL0}?t=${Date.now()}`);

    // a slow load still keeps the 3 s cadence measured from the request start
    vi.advanceTimersByTime(1000);
    last().load();
    vi.advanceTimersByTime(FRAME_MS - 1000 - 1);
    expect(FakeImage.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeImage.all).toHaveLength(3);
    stop();
  });

  it('never has two requests in flight', () => {
    const { stop } = start();
    vi.advanceTimersByTime(FRAME_MS * 2); // first frame never answers before its timeout
    expect(FakeImage.all).toHaveLength(1);
    stop();
  });

  it('counts consecutive errors, reads NO SIGNAL at 3, backs off, and resets on success', () => {
    const { stop, states } = start();
    for (let i = 1; i <= MAX_ERRORS; i++) {
      last().fail();
      expect(states[states.length - 1].errors).toBe(i);
      if (i < MAX_ERRORS) vi.advanceTimersByTime(FRAME_MS);
    }
    expect(noSignal(states[states.length - 1])).toBe(true);
    const n = FakeImage.all.length;
    vi.advanceTimersByTime(FRAME_MS);
    expect(FakeImage.all).toHaveLength(n); // slower retry after the third failure
    vi.advanceTimersByTime(FRAME_MS * (BACKOFF_FACTOR - 1));
    expect(FakeImage.all).toHaveLength(n + 1);
    last().load();
    expect(states[states.length - 1].errors).toBe(0);
    expect(noSignal(states[states.length - 1])).toBe(false);
    stop();
  });

  it('treats a frame that never loads as an error', () => {
    const { stop, states } = start();
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS);
    expect(states[states.length - 1].errors).toBe(1);
    expect(FakeImage.all[0].removed).toBe(true);
    stop();
  });

  it('pauses while the tab is hidden and catches up on return', () => {
    const { stop, states } = start();
    last().load();
    setHidden(true);
    expect(states[states.length - 1].paused).toBe(true);
    vi.advanceTimersByTime(FRAME_MS * 10);
    expect(FakeImage.all).toHaveLength(1);
    setHidden(false);
    expect(FakeImage.all).toHaveLength(2);
    expect(states[states.length - 1].paused).toBe(false);
    stop();
  });

  it('abandons the in-flight frame when the tab hides', () => {
    const { stop, frames } = start();
    setHidden(true);
    expect(FakeImage.all[0].removed).toBe(true);
    FakeImage.all[0].load(); // a late answer is ignored
    expect(frames).toHaveLength(0);
    stop();
  });

  it('reads offline and resumes on the online event', () => {
    online = false;
    const { stop, states } = start();
    expect(FakeImage.all).toHaveLength(0);
    expect(noSignal(states[states.length - 1])).toBe(true);
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(FakeImage.all).toHaveLength(1);
    stop();
  });

  it('stops for good: no timers, no listeners, no late frames', () => {
    const { stop, frames } = start();
    last().load();
    vi.advanceTimersByTime(FRAME_MS);
    expect(FakeImage.all).toHaveLength(2);
    stop();
    expect(FakeImage.all[1].removed).toBe(true);
    FakeImage.all[1].load();
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(FRAME_MS * 20);
    setHidden(true);
    setHidden(false);
    window.dispatchEvent(new Event('online'));
    expect(FakeImage.all).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
