import type { NodeHandler } from '../types.ts';
import { llm } from './llm.ts';
import { http } from './http.ts';
import { transform, conditional, delay, webhookTrigger } from './basic.ts';
import { gmail, slack, sheetsRead, sheetsWrite } from './integrations.ts';
import { kbQuery } from './kb.ts';

export const handlers: Record<string, NodeHandler> = {
  llm,
  http,
  transform,
  conditional,
  delay,
  webhook: webhookTrigger,
  gmail,
  slack,
  sheetsRead,
  sheetsWrite,
  kbQuery,
};
