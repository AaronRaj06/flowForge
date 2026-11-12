import type { NodeHandler } from '../types.ts';
import { sendEmail } from '../../integrations/gmail/actions.ts';
import { postMessage } from '../../integrations/slack/actions.ts';
import { readRows, writeRows } from '../../integrations/sheets/actions.ts';

type Action = (config: Record<string, any>, context: Record<string, any>, userId?: string) => Promise<unknown>;
const fromAction = (action: Action): NodeHandler => ({ run: (config, ctx) => action(config, ctx.context, ctx.userId) });

export const gmail = fromAction(sendEmail);
export const slack = fromAction(postMessage);
export const sheetsRead = fromAction(readRows);
export const sheetsWrite = fromAction(writeRows);
