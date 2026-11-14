import type { NodeHandler } from '../types.ts';
import { llm } from './llm.ts';
import { http } from './http.ts';
import { transform, conditional, delay, webhookTrigger, loop, merge, approval } from './basic.ts';
import { agent } from './agent.ts';
import { discord, telegram, notion, github, airtable } from '../../integrations/keyed/index.ts';
import { gmail, slack, sheetsRead, sheetsWrite } from './integrations.ts';
import { kbQuery } from './kb.ts';

export const handlers: Record<string, NodeHandler> = {
  llm,
  http,
  transform,
  conditional,
  delay,
  loop,
  merge,
  approval,
  agent,
  webhook: webhookTrigger,
  gmail,
  slack,
  sheetsRead,
  sheetsWrite,
  kbQuery,
  discord,
  telegram,
  notion,
  github,
  airtable,
};
