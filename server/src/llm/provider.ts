import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

export type CompletionRequest = {
  provider?: 'anthropic' | 'openai' | 'mock';
  model?: string;
  system?: string;
  prompt: string;
  signal?: AbortSignal;
};
export type Completion = { text: string; inputTokens: number; outputTokens: number };

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-4o-mini', mock: 'mock' } as const;

let anthropic: Anthropic | undefined;
let openai: OpenAI | undefined;

/** With no API key configured, every call falls back to the mock provider. */
function pickProvider(requested?: string): 'anthropic' | 'openai' | 'mock' {
  if (requested === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (requested !== 'mock' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (requested !== 'mock' && process.env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

export async function complete(req: CompletionRequest): Promise<Completion> {
  const provider = pickProvider(req.provider);

  if (provider === 'anthropic') {
    anthropic ??= new Anthropic();
    const model = req.provider === 'anthropic' && req.model ? req.model : DEFAULT_MODELS.anthropic;
    const res = await anthropic.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
        // On a safety decline, the API re-runs the request on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as Anthropic.Beta.MessageCreateParamsNonStreaming,
      { signal: req.signal },
    );
    if (res.stop_reason === 'refusal') throw new Error(`Model declined the request (${res.stop_details?.category ?? 'refusal'})`);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }

  if (provider === 'openai') {
    openai ??= new OpenAI();
    const model = req.provider === 'openai' && req.model ? req.model : DEFAULT_MODELS.openai;
    const res = await openai.chat.completions.create(
      {
        model,
        messages: [
          ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
          { role: 'user' as const, content: req.prompt },
        ],
      },
      { signal: req.signal },
    );
    return {
      text: res.choices[0]?.message?.content ?? '',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    };
  }

  // Mock: deterministic and prompt-dependent, so pipeline ordering is still observable.
  const echo = req.prompt.length > 400 ? req.prompt.slice(0, 400) + '…' : req.prompt;
  return { text: `[mock] ${echo}`, inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(echo.length / 4) };
}

export const EMBEDDING_DIM = 1536;

export async function embed(texts: string[]): Promise<number[][]> {
  if (process.env.OPENAI_API_KEY) {
    openai ??= new OpenAI();
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
    return res.data.map((d) => d.embedding);
  }
  return texts.map(mockEmbedding);
}

/**
 * Bag-of-words hashing embedding: texts that share words land close together,
 * which is enough to demo retrieval without an API key.
 * shortcut: not semantic; set OPENAI_API_KEY for real embeddings.
 */
function mockEmbedding(text: string): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = createHash('md5').update(word).digest();
    v[h.readUInt32BE(0) % EMBEDDING_DIM] += h[4] & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
