import { createApp } from './app.ts';
import { checkProductionConfig } from '../lib/config.ts';
import { prisma, redis } from '../db.ts';

checkProductionConfig();
const port = Number(process.env.PORT ?? 4000);
const server = createApp().listen(port, () => console.log(`API listening on http://localhost:${port}`));

// Finish in-flight requests on deploy/restart instead of dropping them; give up after 10 s (open SSE streams never end on their own).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    console.log(`${sig} received, shutting down`);
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(async () => {
      await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
