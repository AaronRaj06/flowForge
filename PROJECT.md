# Flowforge: A Visual No-Code Builder for AI-Powered Workflow Automation

## 1. Overview

Flowforge is a web-based platform for building AI workflows by dragging blocks onto a canvas and connecting them. The blocks include LLMs, HTTP requests, conditional logic, Gmail, Slack, Google Sheets and a vector-based knowledge base. A finished pipeline can run on a schedule, from a secured webhook, or as a REST endpoint, and the status of each step shows live as it runs. Encrypted credentials, protection against server-side request forgery and per-user token budgets keep it secure and affordable. The goal is to let people without programming skills build AI automation.

| | |
| --- | --- |
| **Theme / Domain** | Artificial Intelligence and Workflow Automation (Generative AI applied to no-code business process automation) |
| **Primary SDG** | SDG 9: Industry, Innovation and Infrastructure (targets 9.5 and 9.c) |
| **Secondary SDG** | SDG 8: Decent Work and Economic Growth (target 8.2) |
| **Status** | All five planned phases implemented; runs locally with Docker |

## 2. Problem Statement

Large language models can reason over text, but getting useful work out of them usually means connecting them to everyday tools such as email, chat, spreadsheets and web APIs. Today that takes custom code: API clients, OAuth handling, retries, scheduling and hosting. Only developers can do it, and each automation is built from scratch.

Existing automation tools offer fixed integrations and treat AI as an add-on step. They rarely make retrieval over a user's own documents, branching on model output, or exposing a workflow as an API first-class features.

## 3. Proposed Solution

Flowforge treats an AI workflow as a **directed acyclic graph (DAG)** of blocks:

1. The user drags blocks onto a canvas and connects them.
2. Blocks pass data to one another through placeholders: `{{input}}` for the run input, `{{llm1.output}}` for another block's output, and `{{http1.output.items.0.title}}` for paths into JSON.
3. The engine checks the graph (no cycles, no missing variables), orders it topologically and runs it, skipping any branch a Conditional block rules out.
4. The status of each block streams back to the canvas live.
5. A finished pipeline can be saved, shared as a template, or deployed.

## 4. Features

### Block library

| Block | Purpose |
| --- | --- |
| **LLM** | Prompt Anthropic Claude or any OpenAI-compatible model (OpenAI, Google Gemini) |
| **HTTP** | Call any REST API (protected against server-side request forgery) |
| **Transform** | JavaScript expression over the run context, sandboxed with a 500 ms limit |
| **Conditional** | True/false branching; the branch not taken is marked as skipped |
| **Delay** | Wait a set time between steps |
| **Gmail** | Send email through the user's connected Google account |
| **Slack** | Post messages to a connected workspace |
| **Google Sheets** | Read and write rows |
| **KB Query** | Semantic search over the user's uploaded documents (retrieval-augmented generation) |

### Platform features

- **Visual builder**: drag-and-drop canvas (React Flow), a settings panel for each block, and live status for each block while it runs.
- **Pipelines and run history**: save, load and re-run pipelines; every run keeps the graph it ran, its output and an event log.
- **Templates**: save a pipeline as a reusable template. Secrets are removed on save, and any placeholder that doesn't refer to a block becomes a variable the user fills in. "Use this" makes a copy of the graph with new IDs.
- **Knowledge base**: upload text or PDF files. They are split into chunks, embedded as 1536-dimension vectors, stored in PostgreSQL with pgvector, and searched with an approximate-nearest-neighbour index.
- **Deployments**:
  - **Cron**: runs on a schedule, with a readable preview of the cron expression.
  - **Webhook**: secured with a shared secret (`X-Webhook-Secret`) or an HMAC-SHA256 signature.
  - **REST endpoint**: a synchronous call that waits for the pipeline and returns its final result.
- **Integrations**: OAuth 2.0 connect, reconnect and automatic token refresh for Gmail, Sheets and Slack.
- **Usage dashboard**: tokens used per user, with a daily budget enforced before a run is queued.
- **Cancellation**: a running pipeline can be stopped before its next block.

## 5. System Architecture

```
┌─────────────┐  HTTP / SSE   ┌──────────────┐  enqueue   ┌──────────────┐
│  Web (React)│ ────────────▶ │  API (Express)│ ─────────▶ │ Redis/BullMQ │
│  :5173      │ ◀──────────── │  :4000        │            └──────┬───────┘
└─────────────┘  live events  └──────┬───────┘                    │ jobs
                                     │ subscribe run:<id>          ▼
                                     │                     ┌──────────────┐
                                     │ ◀── pub/sub ─────── │    Worker    │
                                     ▼                     │ (DAG engine) │
                              ┌──────────────┐  read/write └──────┬───────┘
                              │  PostgreSQL  │ ◀──────────────────┘
                              │  + pgvector  │      LLM APIs, Gmail, Slack,
                              └──────────────┘      Sheets, HTTP targets
```

**Lifecycle of a run**

1. The client sends `POST /api/runs`. The API checks the daily token budget, creates a `Run` row and queues a job on the `pipeline-runs` queue.
2. The worker walks the DAG in topological order (Kahn's algorithm). For each change in a block's status it writes a `RunEvent` to Postgres and publishes it on the Redis channel `run:<id>`.
3. The API's Server-Sent Events (SSE) endpoint subscribes before replaying the events already stored, so the client never misses one, and it always closes when the run ends.
4. A synchronous REST call subscribes to the same channel before queueing the job and stops waiting after `syncTimeout`.
5. Each run job gets exactly one attempt, because blocks can have side effects (emails, Slack posts) that must not repeat.

## 6. Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, React Flow (`@xyflow/react`), Zustand, Tailwind CSS, Radix UI, Vite |
| Backend API | Node.js 22, Express 5, TypeScript, JWT auth, bcrypt, Multer (uploads) |
| Queue / worker | BullMQ on Redis 7, cron-parser |
| Database | PostgreSQL 17 + pgvector, Prisma ORM |
| AI providers | Anthropic SDK (Claude), OpenAI SDK (OpenAI or any OpenAI-compatible API, e.g. Gemini); offline mock provider |
| Integrations | Google OAuth (Gmail, Sheets), Slack OAuth |
| DevOps | Docker Compose (postgres, redis, api, worker, web) |

## 7. Data Model

| Entity | Key fields |
| --- | --- |
| `User` | email, passwordHash |
| `Pipeline` | name, description, graph `{nodes, edges}` |
| `Run` | status, graph snapshot, input, output, error, tokensUsed, timestamps |
| `RunEvent` | nodeId, status (pending / running / success / error / skipped / auth_error), output |
| `IntegrationToken` | provider, accessToken and refreshToken (encrypted with AES-256-GCM), expiresAt |
| `Template` | name, category, graph, variables, public |
| `Deployment` | type (cron / webhook / api), cronExpression, webhookSecret |
| `knowledge_chunks` | content, embedding `vector(1536)` |

## 8. Security and Cost Controls

- OAuth tokens are encrypted at rest with AES-256-GCM.
- HTTP blocks can't reach localhost or private IP ranges by default (SSRF protection).
- User expressions run in a `node:vm` sandbox with no `eval` and a 500 ms timeout.
- Webhook secrets are compared in constant time, and HMAC signatures are supported.
- API keys, tokens and auth headers are removed when a pipeline is saved as a template.
- A per-user daily LLM token budget (50,000 by default) is checked before a run is queued.
- Users can only see and change their own pipelines, runs and deployments.

## 9. Current Status

- **Implemented:** all five phases (engine, visual builder, block library and integrations, templates and knowledge base, deployment and scheduling).
- **Running locally** with Docker Compose: all 5 containers up; web at http://localhost:5173, API at http://localhost:4000.
- **LLM provider:** Google Gemini through its OpenAI-compatible endpoint (`gemini-flash-lite-latest` for chat, `gemini-embedding-001` for 1536-dimension embeddings). Chat, templates and knowledge-base search have been checked against it.
- **Tests:**
  - Unit and feature tests: 14/14 pass (engine, sandbox, `cloneGraph` property test, templates, OAuth refresh and revocation, Sheets → LLM → Gmail with stubbed Google APIs, knowledge base).
  - End-to-end smoke test: 10/10 features pass against the running stack.

### Running it

```bash
docker compose up --build        # then open http://localhost:5173 and register
```

Without any API keys, LLM blocks use the offline mock provider, so the whole app runs without internet. Set `ANTHROPIC_API_KEY`, or set `OPENAI_API_KEY` together with `OPENAI_BASE_URL`, `OPENAI_MODEL` and `OPENAI_EMBEDDING_MODEL` in `server/.env`, to use real models.

### Checks

```bash
npm test                          # unit and feature tests
npm run smoke                     # end-to-end against a running stack (expects the mock provider)
```

## 10. Known Limitations

- `node:vm` is not a hard isolation boundary. It is fine for a single tenant but not for untrusted code from many tenants.
- The SSRF check resolves DNS once before fetching, so a DNS-rebinding attack could get past it.
- Chunk sizes estimate tokens as 0.75 words each.
- The mock embeddings match words, not meaning, so search quality without a real provider is only good enough for demos.
- Two smoke-test assertions expect the mock provider's echo output, so they fail when a real LLM is configured.
- On Gemini's free tier, LLM blocks occasionally get 503 "high demand" errors.

## 11. Future Plan

**Positioning:** n8n is an automation tool with AI added on. Flowforge is AI-native from the ground up.

> *"n8n automates tasks. Flowforge builds, fixes and explains automations for you: describe what you want in plain English, and get a working, cost-aware AI pipeline."*

### Part A: Matching n8n (the basics people will expect)

| Gap | What to add |
| --- | --- |
| **Lists of items** | n8n passes a list of items through every node; Flowforge passes one value. Add **Loop / Split / Merge** blocks so a pipeline can process many rows, emails or records. |
| **Error handling** | Retry with backoff on each block, a "continue on fail" option, and an **error workflow** that runs when a pipeline fails. |
| **More integrations** | Notion, Discord, Telegram, WhatsApp, Outlook, Google Drive, Airtable, PostgreSQL/MySQL, GitHub and Trello/Jira, plus a **generic OAuth / API-key credential** option so any service can be connected. |
| **More triggers** | New email, new row in Sheets, new Slack message, form submission and file upload, alongside the existing cron, webhook and REST triggers. |
| **Credentials manager** | One page to manage all saved keys and tokens, shared across pipelines. |
| **Pinning and partial runs** | Run a single block, freeze ("pin") its output, and re-run from any block. |
| **Sub-workflows** | One pipeline can call another as a block. |
| **Import/export** | Import and export pipelines as JSON so people can share them. |

### Part B: What makes Flowforge stand out

1. **Build a pipeline from plain English.** The user types "Every morning, summarise unread emails and post them to Slack", and the LLM produces the graph on the canvas, ready to edit.
2. **AI self-healing.** When a block fails, an AI reads the error and the block's settings and suggests a fix with a single "Apply" button, for example a corrected HTTP header or a fixed expression.
3. **Built-in knowledge base (RAG).** Already built; n8n needs an external vector database for this. Add a "Chat with your documents" template, citations in answers, and automatic syncing from Google Drive.
4. **Cost awareness.** Show the estimated token cost of each block before a run and the actual cost after, with per-pipeline budgets and suggestions to use a cheaper model for simple steps.
5. **Agent blocks with tools.** An LLM that can call other Flowforge blocks or MCP servers as tools and decide for itself which ones to use, turning workflows into agents.
6. **Human-in-the-loop approval.** The pipeline pauses and sends an "Approve / Reject" request by email or Slack before doing something with consequences, such as messaging customers or making a payment.
7. **Testing and comparing pipelines.** Run the same pipeline on a set of test inputs, compare two prompts or models side by side, and score the outputs.
8. **Replay and step-by-step debugging.** Every run's events are already stored; add a timeline you can scrub to see the data at each step of any past run.

### Part C: Hardening

- Run user code in `isolated-vm` or a separate process to isolate tenants properly.
- Pin the resolved IP when making HTTP requests to close the DNS-rebinding gap.
- Retry with backoff when an LLM returns a temporary error (429 or 503), and allow a fallback model.
- Count tokens exactly when splitting documents into chunks.
- Make the smoke tests pass with a real LLM provider as well as the mock.

### Part D: Teams, production and evaluation

- Team workspaces with roles (owner, editor, viewer), audit logs and per-team quotas.
- Observability: run metrics, cost per pipeline, and alerts when a pipeline fails.
- Cloud deployment (managed Postgres and Redis, worker auto-scaling) with CI/CD.
- A user study comparing how long it takes to build the same workflow in Flowforge, in n8n and in hand-written code, to measure the SDG 8 and SDG 9 impact.

### Roadmap (priority order)

| Step | Work | Why |
| --- | --- | --- |
| 1 | Loop / Split / Merge, retries, error workflow | Biggest gap compared with n8n |
| 2 | Build from plain English, AI self-healing | The features that make the demo stand out |
| 3 | Cost awareness | Builds on the existing token tracking |
| 4 | Human-in-the-loop approval, agent blocks | Moves from workflows to agents |
| 5 | Five new integrations, two new triggers | Wider practical use |
| 6 | Hardening, then teams and production | Ready for real multi-user use |

## 12. Repository Layout

```
web/                 React frontend (Builder, Templates, Knowledge, Usage, Login pages)
server/src/api/      Express routes: auth, pipelines, runs, templates, kb, deployments, integrations
server/src/engine/   DAG engine: topoSort, runPipeline, sandboxed expressions, block handlers
server/src/integrations/  Gmail, Sheets, Slack clients and OAuth token management
server/src/kb/       Chunking, ingestion and vector search
server/src/llm/      Provider abstraction (Anthropic, OpenAI-compatible, mock)
server/src/runs/     Run creation, execution and token budget
server/prisma/       Database schema
server/test/         Unit and feature tests
server/scripts/      Database setup, Phase 1 test run, end-to-end smoke test
docker-compose.yml   Full local stack
```
