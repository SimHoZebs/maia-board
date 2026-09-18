// Race the complete operation, including body consumption. Abort-ignoring fetch
// implementations cannot retain a scheduler slot after cancellation/deadline.
import { isRecord } from './guards';
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeout = 150_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new DOMException('Evaluation timed out. Retry to continue.', 'TimeoutError')); }, timeout);
  });
  try {
    if (signal?.aborted) return await stopped;
    return await Promise.race([run(controller.signal), stopped]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export async function retryBusy(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (response.status !== 503 || attempt === 2) return response;
    const body: unknown = await response.clone().json().catch(() => null);
    if (!isRecord(body) || body.code !== 'engine_busy') return response;
    const header = response.headers.get('Retry-After');
    const numeric = header ? Number(header) : 1;
    const ms = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(header!) - Date.now();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(5000, Math.max(100, Number.isFinite(ms) ? ms : 1000)));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

// Single JSON-body read for engine work: every sender maps an unreadable
// body through its own per-endpoint domain error, but the read itself is one
// shape (null on failure, never a throw).
export async function readJsonBody(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { return null; }
}

// Single JSON-POST shape for engine work: one headers/body/read path for the
// play sender, the evaluation sender, and the batch sender. Busy-retry and
// deadlines layer above in fetchJsonWithBusyRetry; the batch 429 wait-once
// stays in submitBatch; per-endpoint error codes, parses, and cache-hit
// flags stay with the callers.
export async function postJson(
  fetcher: typeof fetch, input: RequestInfo | URL, payload: unknown, signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetcher(input, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  return { response, body: await readJsonBody(response) };
}
// Single fetch path for engine work: deadline + structured busy retry +
// JSON read. Preserves superseded/503 codes for callers; only
// engine_busy 503s retry here. Wire format unchanged.
export async function fetchJsonWithBusyRetry(
  fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit, signal?: AbortSignal, timeout = 150_000,
): Promise<{ response: Response; body: unknown }> {
  return withDeadline(async transportSignal => {
    const response = await retryBusy(fetcher, input, init, transportSignal);
    // Callers map unreadable bodies to domain errors.
    return { response, body: await readJsonBody(response) };
  }, signal, timeout);
}
