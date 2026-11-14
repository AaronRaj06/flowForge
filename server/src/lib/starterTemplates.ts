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
  {
    name: 'Turn bug reports into GitHub issues',
    description: 'Takes a bug report in plain words, has an LLM write a clear title and reproduction steps, and opens a GitHub issue.',
    category: 'Dev',
    graph: {
      nodes: [
        n('title', 'llm', 80, 120, { prompt: 'Write a short, specific GitHub issue title (under 80 characters, no quotes) for this bug report:\n\n{{input}}' }),
        n('details', 'llm', 80, 320, { prompt: 'Rewrite this bug report as a GitHub issue body with the sections Summary, Steps to reproduce, Expected and Actual. Use Markdown.\n\n{{input}}' }),
        n('issue', 'github', 440, 220, { repo: '{{github_repo}}', title: '{{title.output}}', body: '{{details.output}}' }),
      ],
      edges: [e('title', 'issue'), e('details', 'issue')],
    },
  },
  {
    name: 'Save form submissions to Airtable',
    description: 'Deploy as a form; every submission is tagged by an LLM and stored as a row in your Airtable table.',
    category: 'Productivity',
    graph: {
      nodes: [
        n('tag', 'llm', 80, 200, { prompt: 'Give one category for this message: Question, Feedback, Bug or Sales. Reply with the category only.\n\n{{input.Message}}' }),
        n('row', 'airtable', 420, 200, { baseId: '{{airtable_base_id}}', table: '{{airtable_table}}', fields: '{"Name": "{{input.Name}}", "Message": "{{input.Message}}", "Notes": "{{tag.output}}"}' }),
      ],
      edges: [e('tag', 'row')],
    },
  },
  {
    name: 'Meeting notes to Notion',
    description: 'Paste a raw transcript or notes; an LLM writes a summary with decisions and action items and files it as a Notion page.',
    category: 'Productivity',
    graph: {
      nodes: [
        n('title', 'llm', 80, 120, { prompt: 'Give this meeting a short title (under 8 words, no quotes):\n\n{{input}}' }),
        n('notes', 'llm', 80, 320, { prompt: 'Summarise this meeting as: Summary (2-3 sentences), Decisions, Action items (owner: task). Plain text.\n\n{{input}}' }),
        n('page', 'notion', 440, 220, { databaseId: '{{notion_database_id}}', titleProperty: 'Name', title: '{{title.output}}', content: '{{notes.output}}' }),
      ],
      edges: [e('title', 'page'), e('notes', 'page')],
    },
  },
  {
    name: 'Website down alert to Telegram',
    description: 'Run it on a schedule: checks a URL and messages you on Telegram only when the site fails to answer.',
    category: 'Dev',
    graph: {
      nodes: [
        n('check', 'http', 80, 200, { method: 'GET', url: '{{website_url}}', continueOnFail: true }),
        n('isDown', 'conditional', 400, 200, { expression: 'Boolean(input.check.error)' }),
        n('alert', 'telegram', 720, 200, { chatId: '{{telegram_chat_id}}', text: 'Website check failed for {{website_url}}: {{check.error}}' }),
      ],
      edges: [e('check', 'isDown'), e('isDown', 'alert', 'true')],
    },
  },
  {
    name: 'Announce releases on Discord',
    description: 'Paste release notes or a changelog; an LLM turns them into a friendly announcement and posts it to your Discord server.',
    category: 'Marketing',
    graph: {
      nodes: [
        n('announce', 'llm', 80, 200, { prompt: 'Turn these release notes into a short, friendly Discord announcement (under 1,500 characters) with a few bullet points:\n\n{{input}}' }),
        n('post', 'discord', 420, 200, { content: '{{announce.output}}' }),
      ],
      edges: [e('announce', 'post')],
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
