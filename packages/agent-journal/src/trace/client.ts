import http from 'node:http';
import { JournalError, classifyHttpStatus } from '../errors.ts';

export interface TraceStatus {
  archiveId: string;
  captureMode: string;
  maxPageEvents: number;
  highWatermark: number;
}

export interface TracePage {
  body: unknown;
  bytes: number;
}

function parseOrigin(traceUrl: string): { host: string; port: number; hostHeader: string } {
  const url = new URL(traceUrl);
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new JournalError('INVALID_CONFIG', 'config', 'trace_url has an invalid port');
  const hostHeader = `${url.hostname}:${port}`;
  return { host: url.hostname, port, hostHeader };
}

/** Minimal read-only client for the two Trace endpoints Journal needs. */
export class TraceClient {
  private readonly host: string;
  private readonly port: number;
  private readonly hostHeader: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly agent: http.Agent;

  constructor(options: { traceUrl: string; token: string; timeoutSeconds: number }) {
    const origin = parseOrigin(options.traceUrl);
    this.host = origin.host;
    this.port = origin.port;
    this.hostHeader = origin.hostHeader;
    this.token = options.token;
    this.timeoutMs = options.timeoutSeconds * 1000;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  close(): void {
    this.agent.destroy();
  }

  private request(pathName: string): Promise<{ status: number; body: string; bytes: number }> {
    const headers = {
      Host: this.hostHeader,
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: this.host,
        port: this.port,
        path: pathName,
        method: 'GET',
        headers,
        agent: this.agent,
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; chunks.push(chunk); });
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          bytes,
        }));
        response.on('error', (error) => reject(new JournalError('CONNECTION_ERROR', 'transient', `Trace response failed: ${error.message}`)));
      });
      request.on('error', (error) => reject(new JournalError('CONNECTION_ERROR', 'transient', `Trace request failed: ${error.message}`)));
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('request timed out')));
      request.end();
    });
  }

  async status(): Promise<TraceStatus> {
    const response = await this.request('/v1/status');
    if (response.status !== 200) throw classifyHttpStatus(response.status, 'Trace status request failed');
    let value: unknown;
    try { value = JSON.parse(response.body); } catch { throw new JournalError('PROTOCOL', 'permanent', 'Trace status is not JSON'); }
    const status = value as Record<string, unknown>;
    if (!status || typeof status !== 'object' || status.schema_version !== 1) throw new JournalError('PROTOCOL', 'permanent', 'Trace status schema is not v1');
    const protocol = status.protocol as Record<string, unknown> | undefined;
    if (!protocol || protocol.schema_version !== 1) throw new JournalError('PROTOCOL', 'permanent', 'Trace status is missing protocol v1');
    const archive = status.archive as Record<string, unknown> | undefined;
    if (!archive || typeof archive.archive_id !== 'string' || !archive.archive_id) throw new JournalError('PROTOCOL', 'permanent', 'Trace status is missing archive_id');
    if (typeof protocol.max_page_events !== 'number' || !Number.isSafeInteger(protocol.max_page_events) || protocol.max_page_events < 1) {
      throw new JournalError('PROTOCOL', 'permanent', 'Trace status is missing max_page_events');
    }
    const captureMode = typeof archive.capture_mode === 'string' ? archive.capture_mode : 'unknown';
    const highWatermark = typeof archive.high_watermark === 'number' && Number.isSafeInteger(archive.high_watermark) ? archive.high_watermark : 0;
    return {
      archiveId: archive.archive_id,
      captureMode,
      maxPageEvents: protocol.max_page_events,
      highWatermark,
    };
  }

  async page(after: number, limit: number): Promise<TracePage> {
    const response = await this.request(`/v1/events?after=${after}&limit=${limit}&view=content`);
    if (response.status !== 200) throw classifyHttpStatus(response.status, `Trace events request after=${after} failed`);
    let body: unknown;
    try { body = JSON.parse(response.body); } catch { throw new JournalError('PROTOCOL', 'permanent', 'Trace page is not JSON'); }
    return { body, bytes: response.bytes };
  }
}
