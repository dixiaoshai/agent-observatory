import http from 'node:http';
import { FollowError } from './errors.js';

const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function retryAfterSeconds(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = headers['retry-after'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
}

function httpFailure(response: HttpResponse): FollowError {
  let code = `HTTP_${response.status}`;
  let message = `agent-trace returned HTTP ${response.status}`;
  try {
    const payload = JSON.parse(response.body) as { error?: { code?: unknown; message?: unknown } };
    if (payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object') {
      if (typeof payload.error.code === 'string' && payload.error.code) code = payload.error.code;
      if (typeof payload.error.message === 'string' && payload.error.message) message = payload.error.message;
    }
  } catch { /* keep the status-derived fallback */ }
  const transient = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
  return new FollowError(code, transient ? 'transient' : 'permanent', message,
    transient ? retryAfterSeconds(response.headers) : undefined);
}

export function networkFailure(error: NodeJS.ErrnoException): FollowError {
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
    return new FollowError('TIMEOUT', 'transient', 'request timed out');
  }
  return new FollowError('CONNECTION_ERROR', 'transient', error.message || String(error));
}

/** Minimal loopback HTTP client: no redirects, no proxy, bounded response size. */
export class TraceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string, private readonly timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  status(): Promise<unknown> {
    return this.get('/v1/status');
  }

  events(after: number, limit: number): Promise<unknown> {
    return this.get(`/v1/events?after=${after}&limit=${limit}&view=content`);
  }

  private async get(pathname: string): Promise<unknown> {
    const response = await this.request(pathname);
    if (response.status !== 200) throw httpFailure(response);
    try { return JSON.parse(response.body); } catch {
      // Truncated or partly written responses retry; the cursor never moves.
      throw new FollowError('RESPONSE_INVALID', 'transient', 'response is not complete JSON');
    }
  }

  private request(pathname: string): Promise<HttpResponse> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: HttpResponse): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value!);
      };
      const request = http.request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        agent: false,
      }, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy();
            request.destroy();
            finish(new FollowError('PAGE_TOO_LARGE', 'permanent',
              'response exceeds the local size limit; reduce page_size and restart'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString('utf8');
          // Error bodies only need a bounded prefix; success bodies were already bounded above.
          finish(null, { status: response.statusCode ?? 0, headers: response.headers,
            body: body.length > MAX_ERROR_BYTES && (response.statusCode ?? 0) !== 200 ? body.slice(0, MAX_ERROR_BYTES) : body });
        });
        response.on('error', error => finish(networkFailure(error as NodeJS.ErrnoException)));
      });
      request.on('error', error => finish(networkFailure(error as NodeJS.ErrnoException)));
      request.end();
    });
  }
}
