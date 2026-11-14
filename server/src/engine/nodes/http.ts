import type { NodeHandler } from '../types.ts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from 'node:dns';
import httpLib from 'node:http';
import httpsLib from 'node:https';
import { isIP } from 'node:net';

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168|169\.254|0)\./i];
const isPrivate = (addr: string) => PRIVATE.some((re) => re.test(addr));
const allowPrivate = () => process.env.ALLOW_PRIVATE_HTTP === 'true';
const MAX_BYTES = 10 * 1024 * 1024;

/** Fails fast with a clear error for literal private IPs and localhost (the socket-level guard below catches everything else). */
async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol ${url.protocol}`);
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await dnsLookup(host, { all: true })).map((a) => a.address);
  if (host === 'localhost' || addrs.some(isPrivate)) throw new Error(`Requests to private addresses are blocked (${host})`);
  return url;
}

/**
 * DNS lookup used for the actual connection: the address checked here is the one the socket
 * connects to, so a DNS answer that changes between check and connect (rebinding) can't reach
 * an internal address (SSRF).
 */
export function guardedLookup(hostname: string, options: LookupOptions, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookupCb(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return cb(new Error(`Requests to private addresses are blocked (${hostname})`), '');
    if (options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? httpsLib : httpLib;
    if (body !== undefined) headers['content-length'] ??= String(Buffer.byteLength(body));
    const req = lib.request(url, { method, headers, signal, timeout: 15_000, lookup: allowPrivate() ? undefined : (guardedLookup as any) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) req.destroy(new Error('Response is larger than 10 MB'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out after 15s')));
    req.on('error', reject);
    req.end(body);
  });
}

export const http: NodeHandler = {
  async run(config, ctx) {
    const url = await assertPublicUrl(String(config.url ?? ''));
    const method = String(config.method || 'GET').toUpperCase();
    const headers: Record<string, string> =
      typeof config.headers === 'string' && config.headers.trim() ? JSON.parse(config.headers) : { ...(config.headers || {}) };
    // Many APIs refuse requests without one (fetch used to add it for us).
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['user-agent'] = 'Flowforge';
    let body = config.body;
    if (body && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }
    // Redirects aren't followed (a 3xx fails below), so a public URL can't bounce to an internal one.
    const res = await send(url, method, headers, method === 'GET' || method === 'HEAD' ? undefined : body || undefined, ctx.signal);
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    try {
      return JSON.parse(res.text);
    } catch {
      return res.text;
    }
  },
};
