import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** A failure talking to Jev; `retryable` says whether another attempt makes sense. */
export class JevError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'JevError';
  }
}

/** An HTTP error response; 429 and 5xx are retryable. */
export class JevRequestError extends JevError {
  constructor(readonly status: number, body: string) {
    super(`Jev request failed (${status}): ${body.slice(0, 200)}`, status === 429 || status >= 500);
    this.name = 'JevRequestError';
  }
}

/** The request never completed: network failure, timeout. Aborts are not retryable. */
export class JevTransportError extends JevError {
  constructor(override readonly cause: unknown, retryable: boolean) {
    super(`Jev request failed: ${cause instanceof Error ? cause.message : String(cause)}`, retryable);
    this.name = 'JevTransportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) throw new JevRequestError(status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/**
 * The `noul` probability of one answer; throws when it is missing, carries a
 * different answer type, or is not a finite number between 0 and 1.
 */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer: unknown =
    isRecord(answers) && Object.hasOwn(answers, name) ? answers[name] : undefined;
  if (
    !isRecord(answer) ||
    !Object.hasOwn(answer, 'noul') ||
    (answer.type !== undefined && answer.type !== 'noul') ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
