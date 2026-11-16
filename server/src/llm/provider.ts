import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

export type CompletionRequest = {
  provider?: Provider;
  model?: string;
  system?: string;
  prompt: string;
  signal?: AbortSignal;
};
export type Completion = { text: string; inputTokens: number; outputTokens: number };

export type Provider = 'gemini' | 'anthropic' | 'openai' | 'mock';
export const DEFAULT_MODELS = {
  gemini: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  anthropic: 'claude-opus-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  mock: 'mock',
} as const;

const KEY_ENV = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;
const REAL = Object.keys(KEY_ENV) as (keyof typeof KEY_ENV)[];

let anthropic: Anthropic | undefined;
let openai: OpenAI | undefined;
let gemini: OpenAI | undefined;
// Gemini speaks the OpenAI wire format on this endpoint, so it reuses the OpenAI SDK.
const geminiClient = () => (gemini ??= new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: maxRetries() }));

/** The requested provider if its key is set, else the first provider that has a key, else the mock. */
export function pickProvider(requested?: string): Provider {
  if (requested === 'mock') return 'mock';
  const has = (p: keyof typeof KEY_ENV) => Boolean(process.env[KEY_ENV[p]]);
  const wanted = REAL.find((p) => p === requested);
  if (wanted && has(wanted)) return wanted;
  return REAL.find(has) ?? 'mock';
}

// The SDKs retry 429s, 5xx and dropped connections with exponential backoff (honouring Retry-After).
const maxRetries = () => Math.min(Math.max(Number(process.env.LLM_MAX_RETRIES ?? 3), 0), 8);
/** Errors worth trying another model for: rate limits, overload, outages, and an unknown model name. */
const FALLBACK_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504, 529]);

/**
 * Calls the requested model; if it still fails with a temporary error after the SDK's retries,
 * tries LLM_FALLBACK_MODEL once (same provider).
 */
export async function complete(req: CompletionRequest): Promise<Completion> {
  const provider = pickProvider(req.provider);
  if (provider === 'mock') return callModel(provider, req, undefined);
  const model = req.provider === provider && req.model ? req.model : DEFAULT_MODELS[provider];
  const fallback = process.env.LLM_FALLBACK_MODEL;
  try {
    return await callModel(provider, req, model);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (!fallback || fallback === model || req.signal?.aborted || !status || !FALLBACK_STATUSES.has(status)) throw err;
    console.warn(`model ${model} failed with HTTP ${status}; retrying on fallback ${fallback}`);
    return callModel(provider, req, fallback);
  }
}

async function callModel(provider: Provider, req: CompletionRequest, model: string | undefined): Promise<Completion> {
  if (provider === 'anthropic') {
    anthropic ??= new Anthropic({ maxRetries: maxRetries() });
    const res = await anthropic.beta.messages.create(
      {
        model: model!,
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

  if (provider === 'openai' || provider === 'gemini') {
    const client = provider === 'gemini' ? geminiClient() : (openai ??= new OpenAI({ maxRetries: maxRetries() }));
    const res = await client.chat.completions.create(
      {
        model: model!,
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
  // Anthropic has no embeddings API, so embeddings come from Gemini or OpenAI whichever chat provider is used.
  const useGemini = Boolean(process.env.GEMINI_API_KEY);
  if (useGemini || process.env.OPENAI_API_KEY) {
    const client = useGemini ? geminiClient() : (openai ??= new OpenAI({ maxRetries: maxRetries() }));
    const res = await client.embeddings.create({
      model: useGemini ? process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001' : process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: texts,
      dimensions: EMBEDDING_DIM, // must match the vector(1536) column, whatever the provider's native size
    });
    return res.data.map((d) => d.embedding);
  }
  return texts.map(mockEmbedding);
}

/**
 * Bag-of-words hashing embedding: texts that share words land close together,
 * which is enough to demo retrieval without an API key.
 * shortcut: not semantic; set GEMINI_API_KEY or OPENAI_API_KEY for real embeddings.
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
