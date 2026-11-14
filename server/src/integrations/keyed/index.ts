import { prisma } from '../../db.ts';
import { decrypt } from '../../lib/crypto.ts';
import type { NodeHandler } from '../../engine/types.ts';

/** Key-based services: what the secret is, and how to check it looks right before saving. */
export const CREDENTIAL_TYPES: Record<string, { label: string; secret: string; check: RegExp }> = {
  discord: { label: 'Discord', secret: 'Webhook URL', check: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/ },
  telegram: { label: 'Telegram', secret: 'Bot token', check: /^\d+:[\w-]{20,}$/ },
  notion: { label: 'Notion', secret: 'Integration token', check: /^(secret_|ntn_)\w{20,}$/ },
  github: { label: 'GitHub', secret: 'Personal access token', check: /^(ghp_|github_pat_|gho_)\w{20,}$/ },
  airtable: { label: 'Airtable', secret: 'Personal access token', check: /^pat\w{10,}\.\w{20,}$/ },
};

/** The decrypted secret of one of the user's credentials, checked to be of the expected type. */
export async function getSecret(userId: string | undefined, id: unknown, type: string) {
  if (!userId) throw new Error('This block needs a signed-in user');
  if (!id) throw new Error(`Choose a ${CREDENTIAL_TYPES[type].label} credential in the block settings`);
  const c = await prisma.credential.findFirst({ where: { id: String(id), userId } });
  if (!c || c.type !== type) throw new Error(`${CREDENTIAL_TYPES[type].label} credential not found; it may have been deleted`);
  return decrypt(c.secret);
}

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function call(service: string, url: string, init: RequestInit & { json?: unknown }, signal?: AbortSignal) {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'user-agent': 'Flowforge', ...init.headers },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  const body = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`${service} rejected the credential (HTTP ${res.status}); check it on the Credentials page`);
  if (!res.ok) throw new Error(`${service} HTTP ${res.status}: ${body.slice(0, 300)}`);
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return body;
  }
}

export const discord: NodeHandler = {
  async run(c, ctx) {
    if (!c.content) throw new Error('Discord block needs a message');
    const url = await getSecret(ctx.userId, c.credential, 'discord');
    await call('Discord', `${url}?wait=true`, { method: 'POST', json: { content: text(c.content).slice(0, 2000) } }, ctx.signal);
    return { sent: true };
  },
};

export const telegram: NodeHandler = {
  async run(c, ctx) {
    if (!c.chatId || !c.text) throw new Error('Telegram block needs a chat ID and a message');
    const token = await getSecret(ctx.userId, c.credential, 'telegram');
    const res = await call('Telegram', `https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', json: { chat_id: String(c.chatId), text: text(c.text).slice(0, 4096) } }, ctx.signal);
    return { messageId: res?.result?.message_id };
  },
};

export const notion: NodeHandler = {
  async run(c, ctx) {
    if (!c.databaseId || !c.title) throw new Error('Notion block needs a database ID and a title');
    const token = await getSecret(ctx.userId, c.credential, 'notion');
    const res = await call('Notion', 'https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28' },
      json: {
        parent: { database_id: String(c.databaseId).replace(/-/g, '') },
        properties: { [c.titleProperty || 'Name']: { title: [{ text: { content: text(c.title).slice(0, 2000) } }] } },
        ...(c.content && { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: text(c.content).slice(0, 2000) } }] } }] }),
      },
    }, ctx.signal);
    return { pageId: res.id, url: res.url };
  },
};

export const github: NodeHandler = {
  async run(c, ctx) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(c.repo ?? ''))) throw new Error('GitHub block needs a repository like owner/name');
    if (!c.title) throw new Error('GitHub block needs an issue title');
    const token = await getSecret(ctx.userId, c.credential, 'github');
    const res = await call('GitHub', `https://api.github.com/repos/${c.repo}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      json: { title: text(c.title).slice(0, 256), body: c.body ? text(c.body) : undefined },
    }, ctx.signal);
    return { number: res.number, url: res.html_url };
  },
};

export const airtable: NodeHandler = {
  async run(c, ctx) {
    if (!c.baseId || !c.table) throw new Error('Airtable block needs a base ID and a table');
    const fields = typeof c.fields === 'string' ? JSON.parse(c.fields || '{}') : c.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Airtable fields must be a JSON object, e.g. {"Name": "{{input.name}}"}');
    const token = await getSecret(ctx.userId, c.credential, 'airtable');
    const res = await call('Airtable', `https://api.airtable.com/v0/${encodeURIComponent(c.baseId)}/${encodeURIComponent(c.table)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      json: { records: [{ fields }], typecast: true },
    }, ctx.signal);
    return { recordId: res.records?.[0]?.id };
  },
};
