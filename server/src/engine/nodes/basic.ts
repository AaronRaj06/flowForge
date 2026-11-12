import type { NodeHandler } from '../types.ts';
import { evalExpression } from '../sandbox.ts';

export const transform: NodeHandler = {
  rawFields: ['expression'],
  async run(config, ctx) {
    if (!config.expression?.trim()) throw new Error('Transform node needs an expression');
    return evalExpression(config.expression, ctx.context);
  },
};

export const conditional: NodeHandler = {
  rawFields: ['expression'],
  async run(config, ctx) {
    if (!config.expression?.trim()) throw new Error('Conditional node needs an expression');
    return Boolean(evalExpression(config.expression, ctx.context));
  },
};

const MAX_DELAY_MS = 5 * 60_000;

export const delay: NodeHandler = {
  async run(config, ctx) {
    const ms = Math.min(Math.max(Number(config.duration) || 0, 0), MAX_DELAY_MS);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      ctx.signal?.addEventListener('abort', () => (clearTimeout(t), reject(ctx.signal!.reason)), { once: true });
    });
    return { waitedMs: ms };
  },
};

/** Entry point for webhook-triggered pipelines; passes the request body through. */
export const webhookTrigger: NodeHandler = {
  async run(_config, ctx) {
    return ctx.context.input;
  },
};
