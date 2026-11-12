import type { NodeHandler } from '../types.ts';
import { search } from '../../kb/knowledge.ts';

export const kbQuery: NodeHandler = {
  async run(config, ctx) {
    if (!ctx.userId) throw new Error('KB Query needs a signed-in user');
    const query = typeof config.query === 'string' ? config.query : JSON.stringify(config.query);
    if (!query?.trim()) throw new Error('KB Query node needs a query');
    const hits = await search(ctx.userId, query, Math.min(Math.max(Number(config.topK) || 5, 1), 20));
    return hits.map((h) => h.chunkText).join('\n\n');
  },
};
