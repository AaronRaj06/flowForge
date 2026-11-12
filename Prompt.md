# AI Workflow Automation Tool — Implementation Prompt

Nov 9, 2026 · @Aaron

## Project Overview

Build a low-code visual platform that lets users orchestrate multi-step AI pipelines by connecting blocks together — no code required. Each pipeline is a directed acyclic graph (DAG) of functional nodes: LLM calls, HTTP requests, data transforms, conditionals, and third-party integrations. Once built, a pipeline can be run on demand, deployed as a background worker, or exposed as a REST API endpoint.

The reference commercial products are n8n, LangFlow, and Flowise. Building your own from scratch demonstrates DAG execution, real-time UI state management, background job queuing, and AI integration — all in one project. This document is a detailed implementation prompt, structured as five build phases plus supporting specs for data models and architecture. Feed each phase section to an AI coding assistant (e.g., Claude Code) or use it as a solo development spec.

## Tech Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React + React Flow | React Flow is the standard node-editor library; large ecosystem, built-in edge/node abstractions |
| Styling | Tailwind CSS | Utility-first, fast to iterate |
| State (client) | Zustand | Lightweight; React Flow stores node/edge state here |
| Backend | Node.js + Express (or Fastify) | Familiar for most JS devs; large middleware ecosystem |
| Job queue | BullMQ + Redis | Battle-tested queue; supports retries, delayed jobs, priorities |
| Database | PostgreSQL | Stores users, pipelines, runs, templates |
| ORM | Prisma | Type-safe, easy migrations |
| AI calls | Anthropic / OpenAI SDK | Swap via a provider abstraction layer |
| Vector DB (Phase 4) | pgvector (Postgres extension) | No extra service to manage for the knowledge base |
| Auth | JWT + bcrypt, or Clerk | Keep it simple early; swap in OAuth later |
| Deployment | Docker Compose (dev) → Railway/Render (prod) | Simple container setup for each service |

Keep Redis and Postgres in separate Docker containers from day one. The queue worker runs as a third container. This makes scaling each service independently easy later.

## System Architecture

Four separate services communicate through a shared Postgres database and a Redis queue:

1. **API Server** — REST API; handles auth, CRUD for pipelines and templates, enqueues run jobs, streams run logs via SSE.
2. **Queue Worker** — Pulls jobs from BullMQ; executes pipeline runs by traversing the DAG node by node; writes run events back to Postgres.
3. **Postgres** — Single source of truth for all persistent state.
4. **Redis** — Job queue only; optionally used for rate-limiting and caching popular pipeline definitions.

The React frontend talks exclusively to the API server. It never touches Redis or Postgres directly.

### Request lifecycle for a pipeline run

```
Browser  →  POST /api/runs/:pipelineId  →  API Server
                                              ↓ enqueue job (BullMQ)
                                           Redis Queue
                                              ↓ dequeue
                                           Queue Worker
                                              ↓ traverse DAG, call LLMs / HTTP
                                           Postgres (write run events)
                                              ↓ 
Browser  ←  GET /api/runs/:runId/stream  ←  API Server (SSE)
```

This separation means you can scale the queue worker independently and retry failed jobs without touching the API server.

## Phase 1 — Core Pipeline Engine

**Goal:** Execute a hardcoded pipeline in the backend with no UI. Prove that the DAG runner works before building anything visual.

### Prompt

Build a backend DAG execution engine in Node.js that:

1. Accepts a pipeline definition as a JSON object with this shape:

```json
{
  "nodes": [
    { "id": "n1", "type": "llm", "config": { "prompt": "Summarize: {{input}}" } },
    { "id": "n2", "type": "llm", "config": { "prompt": "Translate to Spanish: {{n1.output}}" } }
  ],
  "edges": [
    { "source": "n1", "target": "n2" }
  ]
}
```

2. Performs a topological sort of the nodes using Kahn's algorithm. Throw an error if a cycle is detected.
3. Executes each node in topologically sorted order. Each node receives a `context` object: a key-value map of all previously computed node outputs, plus the initial `input` passed to the run.
4. Resolves `{{variable}}` placeholders in string config fields by looking up the key in `context`. Throw on a missing variable.
5. For `type: "llm"` nodes, calls the Anthropic API with the resolved prompt and stores the response text as `context[nodeId].output`.
6. Returns the final context object on completion.
7. Writes each node's start time, end time, status (`pending | running | success | error`), and output (or error message) to Postgres as a `run_event` row in real time.

**Deliverables:**

- `src/engine/dag.ts` — topological sort, cycle detection.
- `src/engine/runner.ts` — executes a pipeline given a definition + initial input.
- `src/engine/nodes/llm.ts` — LLM node handler.
- `src/engine/nodes/http.ts` — HTTP request node (fetch a URL, return response body).
- A test script `scripts/test-run.ts` that hardcodes a 3-node pipeline (LLM → HTTP → LLM) and runs it, printing the final context.

**Acceptance criteria:**

- The test script runs end to end.
- Swapping the two LLM nodes (reversing the edge) produces different output, confirming order is respected.
- Introducing a cycle (n1 → n2 → n1) throws `CyclicDependencyError`.

## Phase 2 — Visual Builder Frontend

**Goal:** Let users construct pipeline graphs visually. The canvas produces the same JSON the Phase 1 engine consumes.

### Prompt

Build a React app using React Flow that implements a visual pipeline builder:

1. **Canvas** — A `ReactFlow` component fills the main area. Enable minimap, controls, and background grid.
2. **Node palette sidebar** — A panel on the left lists available node types: LLM, HTTP Request, Transform, Conditional. Users drag a node type from the palette onto the canvas to add it. Use React Flow's `onDrop` + `onDragOver` handlers.
3. **Custom node components** — Each node type has a custom React component with:
   - A title bar showing the node type icon + name.
   - A `Handle` for input (left side) and output (right side).
   - An inline config summary (e.g., first 40 chars of the prompt).
4. **Config panel** — When a node is selected, a right-side panel shows an editable form for that node's config (prompt text, URL, method, headers). Changes update Zustand state.
5. **State management** — All nodes and edges live in a Zustand store. The store exposes:
   - `addNode(type, position)` — creates a node with a UUID id and default config.
   - `updateNodeConfig(id, config)` — merges config changes.
   - `getPipelineJSON()` — returns the `{ nodes, edges }` object Phase 1 expects.
6. **Run button** — A toolbar button calls `POST /api/runs` with `getPipelineJSON()`. Display a loading spinner and then stream run events from `GET /api/runs/:runId/stream` (SSE). Show each node's status live by updating a `status` field in the Zustand store, reflected on the canvas node as a coloured border (grey=pending, blue=running, green=success, red=error).
7. **Save pipeline** — A "Save" button calls `POST /api/pipelines` to persist the current graph. Load saved pipelines via `GET /api/pipelines` and render them in a sidebar list.

**File structure:**

```
src/
  components/
    Canvas.tsx
    NodePalette.tsx
    ConfigPanel.tsx
    nodes/
      LLMNode.tsx
      HttpNode.tsx
      TransformNode.tsx
      ConditionalNode.tsx
  store/
    pipelineStore.ts
  hooks/
    useRunStream.ts
```

**Acceptance criteria:**

- Drag two LLM nodes onto the canvas, connect them, fill in prompts, hit Run — the nodes update colour live as the Phase 1 engine executes them.
- Saving a pipeline and refreshing the page loads the saved graph.

**UI taste note:** install [emilkowalski/skills](https://github.com/emilkowalski/skills) (`npx skills@latest add emilkowalski/skills`) in this repo before building the canvas. Point Claude Code at the `animate` and `choreograph` skills for the node status transitions (step 6) and at `pick-ui-library` for the config panel and modals, so it doesn't hand-roll toasts or pick the wrong easing.

## Phase 3 — Block Library and Third-Party Integrations

**Goal:** Expand the node types available on the canvas. Add OAuth-backed integrations. This is the phase the video calls "real hell" — treat each integration as its own self-contained module.

### Core block types to implement

| Node type | Config fields | What it does |
| --- | --- | --- |
| LLM | provider, model, system prompt, user prompt | Calls Claude / GPT with the resolved prompt |
| HTTP Request | method, url, headers (JSON), body | Generic HTTP call; output = parsed JSON response |
| Transform | JavaScript expression | Runs `eval`-safe expression on context (use `vm` sandbox) |
| Conditional | expression, true-branch-id, false-branch-id | Branches the DAG based on a boolean expression |
| Delay | duration (ms) | `setTimeout` wrapper; useful for rate limiting |
| Email (Gmail) | to, subject, body | Sends email via Gmail OAuth integration |
| Slack message | channel, text | Posts a message via Slack Bot Token |
| Google Sheets read | spreadsheetId, range | Fetches rows as an array of objects |
| Google Sheets write | spreadsheetId, range, values | Writes rows |
| Webhook trigger | — | Generates a unique inbound webhook URL that triggers this pipeline |

### Integration architecture prompt

Implement a provider abstraction for third-party integrations:

1. Create a `src/integrations/` directory. Each integration is a folder: `gmail/`, `slack/`, `sheets/`.
2. Each folder exports:
   - `auth.ts` — OAuth 2.0 flow: redirect URL, callback handler, token storage in Postgres (`integration_tokens` table: `userId`, `provider`, `accessToken`, `refreshToken`, `expiresAt`).
   - `actions.ts` — One exported async function per action (e.g., `sendEmail(config, context, userId)`). Actions refresh the token automatically if `expiresAt` has passed.
3. The node runner resolves the `userId` from the run's context and passes it to the action.
4. In the frontend, integration nodes show a "Connect" button in the config panel if the user has not yet authorised that provider. Clicking it opens the OAuth popup via `window.open`.

**Acceptance criteria:**

- A pipeline that reads a Google Sheet row, passes it to an LLM, and emails the result runs end to end.
- Revoking the Gmail token from Google causes the email node to return an `auth_error` status and surface a reconnect prompt in the UI.

## Phase 4 — Templates and Knowledge Base

**Goal:** Let users save and reuse pipeline graphs as templates. Add a RAG-style knowledge base that any LLM node can query for context injection.

### Templates prompt

Implement a template system:

1. **Save as template** — A "Save as Template" button in the toolbar opens a modal: template name, description, category (Productivity / Marketing / Dev / Other), and a toggle to make it public.
2. **Template serialisation** — A template stores the full pipeline JSON (nodes + edges + their configs) in a `templates` Postgres table. Sensitive config fields (API keys, OAuth tokens) are stripped before saving. Add a `template_variables` column: an array of `{ key, description, defaultValue }` objects extracted from `{{variable}}` placeholders found in configs. At instantiation time, the user fills in a form for each variable before the template loads onto the canvas.
3. **Template gallery** — A `/templates` route renders a gallery of public templates. Each card shows name, description, category, author, and a "Use this" button that deep-copies the template JSON into a new pipeline and opens it on the canvas.
4. **Why it's hard:** Deep-copying a graph while preserving edge relationships requires reassigning all node IDs (UUID v4 for each) and rewriting every edge's source/target to the new IDs. Write a `cloneGraph(pipeline)` utility that does this correctly.

### Knowledge base prompt

Implement a per-user knowledge base with RAG retrieval:

1. Enable `pgvector` on Postgres: `CREATE EXTENSION vector`.
2. Create a `knowledge_chunks` table: `id`, `userId`, `sourceFile`, `chunkText`, `embedding vector(1536)`, `createdAt`.
3. Build an ingestion endpoint `POST /api/kb/upload` that accepts a plain text or PDF file, splits it into \~500-token chunks with 50-token overlap, calls the OpenAI Embeddings API (or Anthropic when available) to generate a 1536-dim vector for each chunk, and upserts rows into `knowledge_chunks`.
4. Add a `KB Query` node type to the builder: config has a `query` field (supports `{{variable}}` interpolation). At runtime, embed the resolved query, run a cosine similarity search with `<=>` operator in pgvector, return the top-5 chunks as a string joined by `\n\n`, and store that as the node's output.
5. LLM nodes downstream can then reference `{{kbQuery.output}}` in their prompts.

**Acceptance criteria:**

- Upload a PDF, then run a pipeline with a KB Query node — the retrieved chunks appear in the LLM node's context.
- Clone a public template, fill in its variables, and run it successfully without touching any config field manually.

## Phase 5 — Deployment and Scheduling

**Goal:** Let users deploy a pipeline as a background worker (runs on a cron schedule) or as a public REST API endpoint. This is the phase that makes the project feel like a real product.

### Background worker prompt

Implement scheduled pipeline runs:

1. Add a `deployments` table: `id`, `pipelineId`, `userId`, `type` (`cron | webhook`), `cronExpression`, `webhookSecret`, `active`, `lastRunAt`, `createdAt`.
2. On startup, the queue worker queries all active `cron` deployments and registers them with BullMQ's `RepeatableJob` using the stored cron expression.
3. Build a `POST /api/deployments` endpoint. When `type = "cron"`, validate the cron expression (use `cron-parser`), upsert the repeatable job in BullMQ, and insert the deployment row.
4. Add a `GET /api/deployments/:id/runs` endpoint returning the last 50 run records for a deployment, with status and duration.
5. In the frontend, add a "Deploy" modal reachable from the toolbar. It shows two tabs: **Schedule** (cron input with a human-readable preview using `cronstrue`) and **API** (shows the generated webhook URL and a copy button).

### Webhook (API endpoint) prompt

Implement inbound webhook triggers:

1. Register a `POST /webhooks/:deploymentId` route on the API server. This route: a. Verifies the `X-Webhook-Secret` header against the stored `webhookSecret` (HMAC-SHA256, constant-time comparison). b. Enqueues a pipeline run job, passing the full request body as the pipeline's `input`. c. Returns `{ runId }` immediately (async execution).
2. Users can poll `GET /api/runs/:runId` for status, or subscribe to `GET /api/runs/:runId/stream` for live events.
3. Document the webhook interface in the UI's Deploy modal: show the endpoint URL, secret, and a `curl` example.

### Expose as REST API prompt

Let users call their pipeline as a synchronous API:

1. Add an `api_deployments` table similar to `deployments` but with `syncTimeout` (default 30 seconds).
2. `POST /api/:deploymentId/invoke` runs the pipeline synchronously (awaits the queue worker result up to `syncTimeout`) and returns the final context as JSON.
3. Use a Redis pub/sub channel keyed by `runId` to signal completion from the queue worker back to the API server.

**Acceptance criteria:**

- A cron deployment triggers at the correct time and its run appears in the run history.
- A webhook call returns a `runId` and the pipeline completes in the background.
- A synchronous API call returns the full output context within the timeout.

## Data Models

Complete Prisma schema to initialise before Phase 1:

```prisma
model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  pipelines    Pipeline[]
  runs         Run[]
  tokens       IntegrationToken[]
  createdAt    DateTime  @default(now())
}

model Pipeline {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  name        String
  description String?
  graph       Json      // { nodes: [], edges: [] }
  runs        Run[]
  deployments Deployment[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model Run {
  id         String     @id @default(uuid())
  pipelineId String
  pipeline   Pipeline   @relation(fields: [pipelineId], references: [id])
  userId     String
  user       User       @relation(fields: [userId], references: [id])
  status     RunStatus  @default(PENDING)
  input      Json?
  output     Json?
  events     RunEvent[]
  startedAt  DateTime   @default(now())
  finishedAt DateTime?
}

model RunEvent {
  id        String   @id @default(uuid())
  runId     String
  run       Run      @relation(fields: [runId], references: [id])
  nodeId    String
  status    String   // pending | running | success | error
  output    Json?
  error     String?
  startedAt DateTime?
  endedAt   DateTime?
}

model IntegrationToken {
  id           String   @id @default(uuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  provider     String   // gmail | slack | sheets
  accessToken  String
  refreshToken String?
  expiresAt    DateTime?
  @@unique([userId, provider])
}

model Template {
  id          String   @id @default(uuid())
  authorId    String
  name        String
  description String?
  category    String
  graph       Json
  variables   Json     // [{ key, description, defaultValue }]
  public      Boolean  @default(false)
  createdAt   DateTime @default(now())
}

model Deployment {
  id             String   @id @default(uuid())
  pipelineId     String
  pipeline       Pipeline @relation(fields: [pipelineId], references: [id])
  type           String   // cron | webhook | api
  cronExpression String?
  webhookSecret  String?
  syncTimeout    Int      @default(30)
  active         Boolean  @default(true)
  lastRunAt      DateTime?
  createdAt      DateTime @default(now())
}

enum RunStatus {
  PENDING
  RUNNING
  SUCCESS
  ERROR
  CANCELLED
}
```

## Implementation Notes and Hardest Parts

### Build order recommendation

1. Phase 1 (DAG engine) → 2 (canvas + save/load) → 3 (block library, pick 3 node types) → 3 (OAuth for one integration) → 4 (templates) → 5 (cron deployment). The knowledge base and additional integrations can be added any time after Phase 3.

### Where things actually get hard

**OAuth token management** is the most error-prone part. Access tokens expire. If you do not build automatic refresh from day one, every integration will silently fail after 1 hour. Build a `getValidToken(userId, provider)` utility that checks `expiresAt`, refreshes if needed, and updates the DB — call it in every integration action, not in the OAuth callback.

**Template graph cloning** is deceptively tricky. A pipeline graph is a set of nodes with UUIDs and edges that reference those UUIDs. When a user instantiates a template, you must generate new UUIDs for every node and rewrite every `edge.source` and `edge.target` to the new IDs, while preserving the graph structure exactly. Write and test `cloneGraph()` in isolation with a property-based test: clone any valid graph, assert all edge endpoints still exist as node IDs.

**SSE streaming** requires care with connection lifecycle. The API server must close the SSE connection after the run completes or errors. Use a `finally` block in the stream handler. Redis pub/sub is the cleanest way to bridge the queue worker (which knows when a node finishes) to the API server (which holds the SSE connection).

**Conditional branching** means your DAG executor can no longer simply run all nodes in topological order — it must skip branches whose condition evaluated to false. After running a Conditional node, mark its non-taken branch's subtree as `SKIPPED` in the run events and exclude them from execution.

**Transform node sandbox** — never use raw `eval`. Use Node's `vm` module with a strict context: `vm.runInNewContext(expression, { input: context }, { timeout: 500 })`. Restrict the available globals to prevent arbitrary code execution.

### Cost and API key management

LLM calls cost money. Add a middleware that tracks token usage per run and per user. Expose a usage dashboard. For demos, hardcode a per-user daily token budget (e.g., 50K tokens) enforced before the run is enqueued.

### Suggested MVP scope (for a resume/portfolio demo)

Phases 1 + 2 + three node types (LLM, HTTP, Transform) + pipeline save/load + run history. That alone is a fully demonstrable project. Add OAuth integrations and templates only after the core loop works end to end.
