import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { BL_BASE_URL, BL_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;

export class BjornLundenApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'BjornLundenApiError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof BjornLundenApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

interface BLPaginatedResponse<T> {
  pageRequested: number;
  totalPages: number;
  totalRows: number;
  data: T[];
}

export class BjornLundenClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BL_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(BL_RATE_LIMIT, 'ratelimit:bjornlunden');
  }

  async get<T>(accessToken: string, userKey: string, path: string): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Key': userKey,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BjornLundenApiError(
            `Björn Lunden API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  async getPage<T>(
    accessToken: string,
    userKey: string,
    relativePath: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    const params = new URLSearchParams();
    params.set('pageRequested', String(options?.page ?? 1));
    params.set('rowsRequested', String(options?.pageSize ?? 50));
    params.set('rows', String(options?.pageSize ?? 50));

    const path = `${relativePath}?${params.toString()}`;
    const response = await this.get<BLPaginatedResponse<T>>(accessToken, userKey, path);

    return {
      items: Array.isArray(response.data) ? response.data : [],
      page: response.pageRequested ?? (options?.page ?? 1),
      totalPages: response.totalPages ?? 1,
      totalCount: response.totalRows ?? 0,
    };
  }

  async getAll<T>(accessToken: string, userKey: string, path: string): Promise<T[]> {
    const response = await this.get<T[] | BLPaginatedResponse<T>>(accessToken, userKey, path);
    if (Array.isArray(response)) {
      return response;
    }
    return Array.isArray(response.data) ? response.data : [];
  }

  async getDetail<T>(accessToken: string, userKey: string, path: string): Promise<T> {
    return this.get<T>(accessToken, userKey, path);
  }
}
