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
- There is one TypeScript type error (`server/src/api/runs.ts:29`). It doesn't affect how the app runs.
- On Gemini's free tier, LLM blocks occasionally get 503 "high demand" errors.

## 11. Future Plan

### Phase 6: Hardening (short term)
- Fix the type error at `runs.ts:29` and make the smoke tests pass with a real provider.
- Run user code in `isolated-vm` or a separate process to isolate tenants properly.
- Pin the resolved IP when making HTTP requests to close the DNS-rebinding gap.
- Retry with backoff when an LLM returns a temporary error (429 or 503), and allow a fallback model.
- Count tokens exactly when splitting documents into chunks.

### Phase 7: Builder experience
- Version history for pipelines, with undo and comparison between versions.
- Debug mode: run one block at a time, inspect the data at each step, and replay a run from any block.
- Generate a pipeline from a plain-English description ("AI copilot for building pipelines").
- A public template gallery with ratings and categories.

### Phase 8: More blocks and integrations
- Loop and map blocks to process lists item by item, and parallel fan-out and merge.
- Microsoft Teams, Outlook, Notion, Trello/Jira, Discord, WhatsApp and Telegram.
- Database blocks (PostgreSQL, MySQL, MongoDB), file storage (Google Drive, S3), and image and speech AI blocks.
- Agent blocks: an LLM that can call tools, using other blocks or MCP servers as its tools.

### Phase 9: Teams and production
- Team workspaces with roles (owner, editor, viewer) and credentials shared within a team.
- Audit logs, per-team quotas, and billing based on token usage.
- Observability: run metrics, cost per pipeline, alerts when a pipeline fails.
- Deploy to the cloud (managed Postgres and Redis, worker auto-scaling) with CI/CD.

### Phase 10: Research and evaluation
- Run a user study comparing how long it takes to build the same workflow in Flowforge and in hand-written code.
- Compare the quality of retrieval-augmented answers across embedding models.
- Measure how much manual effort the automated workflows save, to quantify the SDG 8 and SDG 9 impact.

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
