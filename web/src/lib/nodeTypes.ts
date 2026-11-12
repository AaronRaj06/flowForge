import { Bot, Globe, Braces, GitBranch, Timer, Mail, MessageSquare, Sheet, Webhook, BookOpen, type LucideIcon } from 'lucide-react';

export type Field = {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'code' | 'select' | 'number' | 'json';
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
};

export type NodeMeta = {
  type: string;
  label: string;
  icon: LucideIcon;
  group: 'Core' | 'Integrations' | 'Knowledge';
  prefix: string;
  defaultConfig: Record<string, any>;
  fields: Field[];
  summary: (c: Record<string, any>) => string;
  integration?: 'gmail' | 'slack' | 'sheets';
  /** Conditional nodes expose true/false outputs. */
  branches?: boolean;
  /** Trigger nodes have no input handle. */
  trigger?: boolean;
};

const cut = (s: unknown, n = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export const NODE_TYPES: NodeMeta[] = [
  {
    type: 'llm',
    label: 'LLM',
    icon: Bot,
    group: 'Core',
    prefix: 'llm',
    defaultConfig: { provider: 'anthropic', model: 'claude-opus-5-5', systemPrompt: '', prompt: '' },
    fields: [
      { key: 'provider', label: 'Provider', kind: 'select', options: [{ value: 'anthropic', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI' }, { value: 'mock', label: 'Mock (no API call)' }] },
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'claude-opus-5-5' },
      { key: 'systemPrompt', label: 'System prompt', kind: 'textarea', placeholder: 'You are a concise assistant.' },
      { key: 'prompt', label: 'Prompt', kind: 'textarea', placeholder: 'Summarize: {{input}}' },
    ],
    summary: (c) => cut(c.prompt) || 'No prompt yet',
  },
  {
    type: 'http',
    label: 'HTTP Request',
    icon: Globe,
    group: 'Core',
    prefix: 'http',
    defaultConfig: { method: 'GET', url: '', headers: '', body: '' },
    fields: [
      { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })) },
      { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://api.example.com/items/{{input.id}}' },
      { key: 'headers', label: 'Headers (JSON)', kind: 'json', placeholder: '{ "Accept": "application/json" }' },
      { key: 'body', label: 'Body', kind: 'code', placeholder: '{ "text": "{{llm1.output}}" }' },
    ],
    summary: (c) => (c.url ? `${c.method} ${cut(c.url, 32)}` : 'No URL yet'),
  },
  {
    type: 'transform',
    label: 'Transform',
    icon: Braces,
    group: 'Core',
    prefix: 'transform',
    defaultConfig: { expression: '' },
    fields: [{ key: 'expression', label: 'JavaScript expression', kind: 'code', placeholder: 'input.http1.output.items.map(i => i.title)', hint: '`input` is the run context: input.input is the run input, input.<node>.output a node’s output. Runs sandboxed with a 500ms limit.' }],
    summary: (c) => cut(c.expression) || 'No expression yet',
  },
  {
    type: 'conditional',
    label: 'Conditional',
    icon: GitBranch,
    group: 'Core',
    prefix: 'if',
    defaultConfig: { expression: '' },
    fields: [{ key: 'expression', label: 'Condition', kind: 'code', placeholder: 'input.llm1.output.includes("urgent")', hint: 'True runs the green branch, false the red one. The branch not taken is skipped.' }],
    summary: (c) => cut(c.expression) || 'No condition yet',
    branches: true,
  },
  {
    type: 'delay',
    label: 'Delay',
    icon: Timer,
    group: 'Core',
    prefix: 'delay',
    defaultConfig: { duration: 1000 },
    fields: [{ key: 'duration', label: 'Duration (ms)', kind: 'number', hint: 'Up to 5 minutes.' }],
    summary: (c) => `Wait ${Number(c.duration || 0).toLocaleString()} ms`,
  },
  {
    type: 'webhook',
    label: 'Webhook Trigger',
    icon: Webhook,
    group: 'Core',
    prefix: 'webhook',
    defaultConfig: {},
    fields: [],
    summary: () => 'Starts on an inbound webhook (Deploy → Webhook)',
    trigger: true,
  },
  {
    type: 'gmail',
    label: 'Email (Gmail)',
    icon: Mail,
    group: 'Integrations',
    prefix: 'email',
    integration: 'gmail',
    defaultConfig: { to: '', subject: '', body: '' },
    fields: [
      { key: 'to', label: 'To', kind: 'text', placeholder: 'someone@example.com' },
      { key: 'subject', label: 'Subject', kind: 'text' },
      { key: 'body', label: 'Body', kind: 'textarea', placeholder: '{{llm1.output}}' },
    ],
    summary: (c) => (c.to ? `To ${cut(c.to, 30)}` : 'No recipient yet'),
  },
  {
    type: 'slack',
    label: 'Slack Message',
    icon: MessageSquare,
    group: 'Integrations',
    prefix: 'slack',
    integration: 'slack',
    defaultConfig: { channel: '', text: '' },
    fields: [
      { key: 'channel', label: 'Channel', kind: 'text', placeholder: '#general or channel ID' },
      { key: 'text', label: 'Text', kind: 'textarea' },
    ],
    summary: (c) => (c.channel ? `Post to ${cut(c.channel, 28)}` : 'No channel yet'),
  },
  {
    type: 'sheetsRead',
    label: 'Sheets: Read',
    icon: Sheet,
    group: 'Integrations',
    prefix: 'sheet',
    integration: 'sheets',
    defaultConfig: { spreadsheetId: '', range: 'Sheet1!A1:Z100' },
    fields: [
      { key: 'spreadsheetId', label: 'Spreadsheet ID', kind: 'text', hint: 'The long ID in the sheet’s URL.' },
      { key: 'range', label: 'Range', kind: 'text', placeholder: 'Sheet1!A1:Z100' },
    ],
    summary: (c) => (c.spreadsheetId ? `Read ${c.range}` : 'No spreadsheet yet'),
  },
  {
    type: 'sheetsWrite',
    label: 'Sheets: Write',
    icon: Sheet,
    group: 'Integrations',
    prefix: 'sheetw',
    integration: 'sheets',
    defaultConfig: { spreadsheetId: '', range: 'Sheet1!A1', values: '' },
    fields: [
      { key: 'spreadsheetId', label: 'Spreadsheet ID', kind: 'text' },
      { key: 'range', label: 'Range', kind: 'text', placeholder: 'Sheet1!A1' },
      { key: 'values', label: 'Values', kind: 'code', placeholder: '[["{{llm1.output}}"]] or {{transform1.output}}', hint: 'A 2D array of rows, or an array of objects.' },
    ],
    summary: (c) => (c.spreadsheetId ? `Write ${c.range}` : 'No spreadsheet yet'),
  },
  {
    type: 'kbQuery',
    label: 'KB Query',
    icon: BookOpen,
    group: 'Knowledge',
    prefix: 'kb',
    defaultConfig: { query: '', topK: 5 },
    fields: [
      { key: 'query', label: 'Query', kind: 'textarea', placeholder: '{{input}}', hint: 'Returns the 5 closest chunks from your knowledge base, joined by blank lines.' },
    ],
    summary: (c) => cut(c.query) || 'No query yet',
  },
];

export const META: Record<string, NodeMeta> = Object.fromEntries(NODE_TYPES.map((m) => [m.type, m]));
