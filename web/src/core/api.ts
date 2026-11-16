// Typed client for the read-only API (plan §2). Manual ETags: requests use `cache: 'no-store'`
// and send `If-None-Match` themselves, so a 304 is visible to the poller.
import type {
  Catalog,
  ChangesPage,
  EntityDetail,
  EventDetail,
  EventsPage,
  Health,
  LayerCollection,
  SeriesResponse,
} from '../types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const API_BASE = '/api';

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = res.status === 404 ? 'not_found' : res.status >= 500 ? 'internal' : 'bad_request';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    // non-JSON error body: keep the defaults
  }
  return new ApiError(res.status, code, message);
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { cache: 'no-store', ...init });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Network error');
  }
  return res;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await send(path, { signal });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

export type LayerResult = { status: 200; etag: string | null; body: LayerCollection } | { status: 304 };

export type ChangesResult = { status: 200; etag: string | null; body: ChangesPage } | { status: 304 };

export const api = {
  catalog(): Promise<Catalog> {
    return getJson<Catalog>('/layers');
  },
  async layer(
    id: string,
    params: Record<string, string>,
    etag: string | null,
    signal?: AbortSignal,
  ): Promise<LayerResult> {
    const headers: Record<string, string> = {};
    if (etag) headers['If-None-Match'] = etag;
    const res = await send(`/layers/${enc(id)}${query(params)}`, { headers, signal });
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw await errorFrom(res);
    const body = (await res.json()) as LayerCollection;
    return { status: 200, etag: res.headers.get('ETag'), body };
  },
  async changes(etag: string | null, signal?: AbortSignal): Promise<ChangesResult> {
    const headers: Record<string, string> = {};
    if (etag) headers['If-None-Match'] = etag;
    const res = await send('/changes', { headers, signal });
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw await errorFrom(res);
    return { status: 200, etag: res.headers.get('ETag'), body: (await res.json()) as ChangesPage };
  },
  health(): Promise<Health> {
    return getJson<Health>('/health');
  },
  entity(kind: string, id: string): Promise<EntityDetail> {
    return getJson<EntityDetail>(`/entities/${enc(kind)}/${enc(id)}`);
  },
  series(kind: string, id: string, metrics: string[], hours: number, ahead: number): Promise<SeriesResponse> {
    return getJson<SeriesResponse>(
      `/entities/${enc(kind)}/${enc(id)}/series${query({ metrics: metrics.join(','), hours, ahead })}`,
    );
  },
  event(source: string, id: string): Promise<EventDetail> {
    return getJson<EventDetail>(`/events/${enc(source)}/${enc(id)}`);
  },
  events(layer: string, o: { status?: string; limit?: number; offset?: number } = {}): Promise<EventsPage> {
    return getJson<EventsPage>(`/events${query({ layer, status: o.status, limit: o.limit, offset: o.offset })}`);
  },
};

export type Api = typeof api;
