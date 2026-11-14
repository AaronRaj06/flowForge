import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionConfig } from '../src/lib/config.ts';
import { rateLimit } from '../src/lib/rateLimit.ts';
import { STARTER_TEMPLATES } from '../src/lib/starterTemplates.ts';
import { parseGraph } from '../src/api/http.ts';
import { extractVariables } from '../src/lib/templates.ts';
import { prisma, redis } from '../src/db.ts';

after(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

test('production config check rejects weak or missing secrets', () => {
  const good = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), TOKEN_ENCRYPTION_KEY: 'y'.repeat(40), DATABASE_URL: 'pg', REDIS_URL: 'r', PUBLIC_URL: 'https://a', WEB_URL: 'https://a' };
  assert.doesNotThrow(() => checkProductionConfig(good));
  assert.doesNotThrow(() => checkProductionConfig({ NODE_ENV: 'development' }));
  assert.throws(() => checkProductionConfig({ ...good, JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.throws(() => checkProductionConfig({ ...good, TOKEN_ENCRYPTION_KEY: 'another-long-random-string-padded-out-to-40-chars' }), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => checkProductionConfig({ ...good, PUBLIC_URL: undefined }), /PUBLIC_URL/);
});

test('rate limit allows up to the limit, then answers 429', async () => {
  const key = `test:${Date.now()}`;
  for (let i = 0; i < 3; i++) await rateLimit(key, 3);
  await assert.rejects(rateLimit(key, 3), (e: any) => e.status === 429);
});

test('starter templates are valid graphs with fill-in variables where needed', () => {
  for (const t of STARTER_TEMPLATES) {
    assert.doesNotThrow(() => parseGraph(t.graph), t.name);
    for (const n of t.graph.nodes) assert.equal(n.id, n.name, `${t.name}: ids double as placeholder names`);
  }
  const vars = (name: string) => extractVariables(STARTER_TEMPLATES.find((t) => t.name === name)!.graph).map((v) => v.key);
  assert.deepEqual(vars('Summarise and post to Slack'), ['slack_channel']);
  assert.deepEqual(vars('Answer questions from your documents'), []);
});
