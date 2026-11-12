import type { NodeHandler } from '../types.ts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168|169\.254)\./i];

/**
 * Pipelines run on our server, so block requests to internal addresses (SSRF).
 * shortcut: checks DNS once before fetch, so DNS rebinding can slip through; pin the resolved IP if this goes multi-tenant.
 */
async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol ${url.protocol}`);
  if (process.env.ALLOW_PRIVATE_HTTP === 'true') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await dnsLookup(host, { all: true })).map((a) => a.address);
  if (host === 'localhost' || addrs.some((a) => PRIVATE.some((re) => re.test(a)))) {
    throw new Error(`Requests to private addresses are blocked (${host})`);
  }
  return url;
}

export const http: NodeHandler = {
  async run(config, ctx) {
    const url = await assertPublicUrl(String(config.url ?? ''));
    const method = String(config.method || 'GET').toUpperCase();
    const headers: Record<string, string> =
      typeof config.headers === 'string' && config.headers.trim() ? JSON.parse(config.headers) : config.headers || {};
    let body = config.body;
    if (body && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }

    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(ctx.signal ? [ctx.signal] : [])]);
    const res = await fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body || undefined, signal, redirect: 'error' });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },
};
