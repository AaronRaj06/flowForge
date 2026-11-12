import type { NodeHandler } from '../types.ts';
import { complete } from '../../llm/provider.ts';

export const llm: NodeHandler = {
  async run(config, ctx) {
    const prompt = String(config.prompt ?? config.userPrompt ?? '');
    if (!prompt.trim()) throw new Error('LLM node needs a prompt');
    const res = await complete({
      provider: config.provider,
      model: config.model,
      system: config.systemPrompt || undefined,
      prompt,
      signal: ctx.signal,
    });
    ctx.addTokens(res.inputTokens + res.outputTokens);
    return res.text;
  },
};
