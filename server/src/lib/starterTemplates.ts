import { prisma } from '../db.ts';
import { extractVariables } from './templates.ts';
import type { Graph } from '../engine/types.ts';

// Official templates shown to every user. The author account cannot sign in ("flowforge" is not an email and "!" is not a bcrypt hash).
const AUTHOR = 'flowforge';
const n = (id: string, type: string, x: number, y: number, config: Record<string, unknown>) => ({ id, name: id, type, position: { x, y }, config });
const e = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}-${target}`, source, target, sourceHandle });

export const STARTER_TEMPLATES: { name: string; description: string; category: string; graph: Graph }[] = [
  {
    name: 'Summarise and post to Slack',
    description: 'Paste any text or send it to a webhook; an LLM writes a three-bullet summary and posts it to a Slack channel.',
    category: 'Productivity',
    graph: { nodes: [n('llm1', 'llm', 80, 200, { prompt: 'Summarise the following in three short bullet points:\n\n{{input}}' }), n('slack1', 'slack', 420, 200, { channel: '{{slack_channel}}', text: '{{llm1.output}}' })], edges: [e('llm1', 'slack1')] },
  },
  {
    name: 'Triage support messages',
    description: 'Classifies an incoming message; urgent ones are posted to Slack straight away, the rest get a short summary.',
    category: 'Productivity',
    graph: {
      nodes: [
        n('classify', 'llm', 80, 200, { prompt: 'Reply with exactly one word, URGENT or NORMAL, for this customer message:\n\n{{input}}' }),
        n('isUrgent', 'conditional', 400, 200, { expression: 'String(input.classify.output).toUpperCase().includes("URGENT")' }),
        n('alert', 'slack', 720, 100, { channel: '{{slack_channel}}', text: 'Urgent customer message:\n{{input}}' }),
        n('summary', 'llm', 720, 320, { prompt: 'Summarise this customer message in one sentence:\n\n{{input}}' }),
      ],
      edges: [e('classify', 'isUrgent'), e('isUrgent', 'alert', 'true'), e('isUrgent', 'summary', 'false')],
    },
  },
  {
    name: 'Answer questions from your documents',
    description: 'Searches your knowledge base for the question and answers only from what it finds (retrieval-augmented generation).',
    category: 'Productivity',
    graph: {
      nodes: [
        n('search', 'kbQuery', 80, 200, { query: '{{input}}' }),
        n('answer', 'llm', 420, 200, { prompt: 'Answer the question using only the context. If the answer is not there, say so.\n\nContext:\n{{search.output}}\n\nQuestion: {{input}}' }),
      ],
      edges: [e('search', 'answer')],
    },
  },
  {
    name: 'Daily API digest by email',
    description: 'Fetches JSON from an API, summarises it with an LLM and emails the digest. Deploy it on a schedule.',
    category: 'Dev',
    graph: {
      nodes: [
        n('fetch', 'http', 80, 200, { method: 'GET', url: '{{api_url}}' }),
        n('digest', 'llm', 400, 200, { prompt: 'Write a short, readable digest of this data for a busy reader:\n\n{{fetch.output}}' }),
        n('email', 'gmail', 720, 200, { to: '{{recipient_email}}', subject: 'Your daily digest', body: '{{digest.output}}' }),
      ],
      edges: [e('fetch', 'digest'), e('digest', 'email')],
    },
  },
  {
    name: 'Draft a reply, approve, then send',
    description: 'An LLM drafts a reply, a person approves or rejects it, and only approved replies are emailed.',
    category: 'Marketing',
    graph: {
      nodes: [
        n('draft', 'llm', 80, 200, { prompt: 'Write a polite, concise reply to this message:\n\n{{input}}' }),
        n('review', 'approval', 400, 200, { message: 'Send this reply?\n\n{{draft.output}}' }),
        n('send', 'gmail', 720, 200, { to: '{{customer_email}}', subject: 'Re: your message', body: '{{draft.output}}' }),
      ],
      edges: [e('draft', 'review'), e('review', 'send', 'true')],
    },
  },
];

/** Creates or refreshes the official templates; safe to run on every start. */
export async function seedStarterTemplates() {
  const author = await prisma.user.upsert({ where: { email: AUTHOR }, update: {}, create: { email: AUTHOR, passwordHash: '!' } });
  for (const t of STARTER_TEMPLATES) {
    const data = { ...t, graph: t.graph as object, variables: extractVariables(t.graph) as object[], public: true };
    const existing = await prisma.template.findFirst({ where: { authorId: author.id, name: t.name } });
    if (existing) await prisma.template.update({ where: { id: existing.id }, data });
    else await prisma.template.create({ data: { ...data, authorId: author.id } });
  }
}
