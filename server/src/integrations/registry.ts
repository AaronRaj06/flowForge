import type { ProviderAuth } from './types.ts';
import { gmailAuth } from './gmail/auth.ts';
import { sheetsAuth } from './sheets/auth.ts';
import { slackAuth } from './slack/auth.ts';

export const providers: Record<string, ProviderAuth> = { gmail: gmailAuth, sheets: sheetsAuth, slack: slackAuth };
