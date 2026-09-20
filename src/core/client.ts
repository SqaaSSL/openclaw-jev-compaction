import { buildJevRequest, JevTransportError, parseJevResponse } from './request.js';
import type { JevAskOptions, JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Deadline for one request, response body included. Default 15000 ms. */
  timeoutMs?: number;
  /** Cancels every request of this client. */
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Jev request aborted');
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive number of milliseconds');
    }
    this.signal = options.signal;
  }

  async ask(state: JevState, questions: JevQuestions, options: JevAskOptions = {}): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const outer = [this.signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    for (const signal of outer) if (signal.aborted) throw abortReason(signal);
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    const forward = outer.map((signal) => {
      const onAbort = (): void => controller.abort(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      return () => signal.removeEventListener('abort', onAbort);
    });
    const timer = setTimeout(() => {
      const error = new Error(`Jev request timed out after ${this.timeoutMs} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      // a caller abort is final; a timeout or network failure may be retried
      if (outer.some((signal) => signal.aborted)) throw controller.signal.reason;
      const timedOut = controller.signal.aborted;
      throw new JevTransportError(timedOut ? controller.signal.reason : error, true);
    } finally {
      clearTimeout(timer);
      for (const off of forward) off();
    }
    return parseJevResponse(response.status, response.ok, text);
  }
}
