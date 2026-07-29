import type { KeeperHubConfig } from '@assay/config';

/**
 * Thin HTTP client for the KeeperHub API.
 *
 * Handles the parts of their protocol that are easy to get wrong and expensive
 * to get wrong silently: bearer auth, the `Idempotency-Key` header, rate-limit
 * headers, and the distinction between the three different 409 conditions their
 * idempotency layer can return.
 *
 * Reference: docs/api/direct-execution.md and docs/api/errors.md in
 * github.com/KeeperHub/keeperhub.
 */
export class KeeperHubClient {
  private readonly apiBase: string;
  private readonly apiKey: string;

  constructor(config: KeeperHubConfig) {
    if (!config.apiKey) {
      throw new KeeperHubError('KH_API_KEY is not set; cannot call the KeeperHub API', 0);
    }
    this.apiBase = config.apiBase.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<Response_<T>> {
    return this.request<T>('POST', path, body, options);
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<Response_<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Response_<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Their idempotency is a header, not a body field. Sending it in the body
    // is silently ignored, which reads as "idempotency is not working".
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

    let raw: Response;
    try {
      raw = await fetch(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new KeeperHubError(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await raw.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }

    const rateLimit = readRateLimit(raw.headers);
    const pollHintSeconds = numberHeader(raw.headers, 'x-poll-interval-hint');

    if (!raw.ok) {
      throw KeeperHubError.fromResponse(raw.status, parsed, rateLimit);
    }

    return { status: raw.status, data: parsed as T, rateLimit, pollHintSeconds };
  }
}

export interface RequestOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface Response_<T> {
  status: number;
  data: T;
  rateLimit?: RateLimit;
  /** Seconds to wait before polling again. 0 means terminal — stop polling. */
  pollHintSeconds?: number;
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  retryAfterSeconds?: number;
}

/**
 * Structured KeeperHub failure.
 *
 * `code` carries their machine-readable discriminator where they provide one.
 * `idempotency_conflict` and `idempotency_in_progress` mean very different
 * things — one is a client bug, the other is "try again shortly" — so the retry
 * layer needs to tell them apart rather than treating every 409 the same.
 */
export class KeeperHubError extends Error {
  readonly httpStatus: number;
  readonly code?: string;
  readonly originalExecutionId?: string;
  readonly rateLimit?: RateLimit;
  readonly body?: unknown;

  constructor(
    message: string,
    httpStatus: number,
    extra: {
      code?: string;
      originalExecutionId?: string;
      rateLimit?: RateLimit;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'KeeperHubError';
    this.httpStatus = httpStatus;
    this.code = extra.code;
    this.originalExecutionId = extra.originalExecutionId;
    this.rateLimit = extra.rateLimit;
    this.body = extra.body;
  }

  static fromResponse(status: number, body: unknown, rateLimit?: RateLimit): KeeperHubError {
    const b = (body ?? {}) as Record<string, unknown>;
    const message =
      (typeof b.error === 'string' && b.error) ||
      (typeof b.message === 'string' && b.message) ||
      `KeeperHub returned HTTP ${status}`;
    const detail = typeof b.details === 'string' ? ` (${b.details})` : '';

    return new KeeperHubError(`${message}${detail}`, status, {
      code: typeof b.code === 'string' ? b.code : undefined,
      originalExecutionId:
        typeof b.originalExecutionId === 'string' ? b.originalExecutionId : undefined,
      rateLimit,
      body,
    });
  }

  /** A different request body was sent under a key that is already taken. */
  get isIdempotencyConflict(): boolean {
    return this.httpStatus === 409 && this.code === 'idempotency_conflict';
  }

  /** The first request under this key is still running. Retrying is correct. */
  get isIdempotencyInProgress(): boolean {
    return this.httpStatus === 409 && this.code === 'idempotency_in_progress';
  }

  get isRateLimited(): boolean {
    return this.httpStatus === 429;
  }

  /** Daily spending cap, per docs/api/direct-execution.md. */
  get isSpendingCapExceeded(): boolean {
    return this.httpStatus === 403 && /spending cap/i.test(this.message);
  }

  get isWalletNotConfigured(): boolean {
    return this.httpStatus === 422 || this.code === 'WALLET_NOT_CONFIGURED';
  }

  /** Worth trying again with a fresh key; a 4xx client error usually is not. */
  get isTransient(): boolean {
    return (
      this.httpStatus === 0 ||
      this.httpStatus >= 500 ||
      this.isRateLimited ||
      this.isIdempotencyInProgress
    );
  }
}

function readRateLimit(headers: Headers): RateLimit | undefined {
  const limit = numberHeader(headers, 'x-ratelimit-limit');
  const remaining = numberHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = numberHeader(headers, 'x-ratelimit-reset');
  const retryAfterSeconds = numberHeader(headers, 'retry-after');
  if (
    limit === undefined &&
    remaining === undefined &&
    resetSeconds === undefined &&
    retryAfterSeconds === undefined
  ) {
    return undefined;
  }
  return { limit, remaining, resetSeconds, retryAfterSeconds };
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
