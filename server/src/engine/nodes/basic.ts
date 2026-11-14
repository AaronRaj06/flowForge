import type { NodeHandler } from '../types.ts';
import { evalExpression } from '../sandbox.ts';
import { ApprovalPending } from '../errors.ts';

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

/** Evaluates to a list; the runner then runs the loop body once per item. */
export const loop: NodeHandler = {
  rawFields: ['items'],
  async run(config, ctx) {
    if (!config.items?.trim()) throw new Error('Loop node needs an items expression');
    const items = evalExpression(config.items, ctx.context);
    if (!Array.isArray(items)) throw new Error(`Loop items must be a list, got ${items === null ? 'null' : typeof items}`);
    if (items.length > MAX_LOOP_ITEMS) throw new Error(`Loops are limited to ${MAX_LOOP_ITEMS} items (got ${items.length})`);
    return items;
  },
};

/** Combines upstream outputs: one input passes through, several become { name: output }. */
export const merge: NodeHandler = {
  async run(_config, ctx) {
    const values = Object.values(ctx.inputs);
    return values.length === 1 ? values[0] : ctx.inputs;
  },
};

const MAX_LOOP_ITEMS = 1000;
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

/** Pauses the run until someone approves or rejects; then outputs the decision and takes the matching branch. */
export const approval: NodeHandler = {
  async run(config, ctx) {
    const decision = ctx.context.__approvals?.[ctx.nodeId];
    if (!decision) throw new ApprovalPending(ctx.nodeId, String(config.message ?? '').slice(0, 4000));
    return decision; // { approved, comment, decidedAt }
  },
};
