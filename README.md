# Flowforge

A visual builder for AI pipelines. Drag blocks (LLM, HTTP, Transform, Conditional, Delay, Gmail, Slack, Google Sheets, KB Query) onto a canvas, connect them, and run the graph on demand, on a cron schedule, from a webhook, or as a synchronous REST endpoint.

Built from `Prompt.md` (all five phases).

```
web/     React + React Flow + Zustand + Tailwind      (Vite, :5173)
server/  Express API (:4000) + BullMQ queue worker    (Prisma/Postgres, Redis)
```

## Run it

Prerequisites: Node 22+, Postgres 15+ with [pgvector](https://github.com/pgvector/pgvector), Redis.

```bash
npm install
cp server/.env.example server/.env        # edit DATABASE_URL if needed
createdb flowforge
npm run db:setup -w server                # vector extension, schema, ANN index
npm run dev                               # API + worker + web
```

Open http://localhost:5173 and create an account.

Or with Docker: `docker compose up --build` (Postgres + pgvector, Redis, API, worker, web as separate containers).

### API keys

With no keys set, LLM blocks use a built-in **mock provider** (it echoes the prompt) and the knowledge base uses a bag-of-words embedding, so everything runs offline.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | LLM blocks call Claude (`claude-opus-5-5` by default, with the server-side refusal fallback enabled) |
| `OPENAI_API_KEY` | LLM blocks set to OpenAI work; KB embeddings use `text-embedding-3-small` (1536-d) |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Gmail and Sheets “Connect” buttons. Redirect URI: `{PUBLIC_URL}/api/integrations/{gmail\|sheets}/callback` |
| `SLACK_CLIENT_ID` / `_SECRET` | Slack “Connect”. Redirect URI: `{PUBLIC_URL}/api/integrations/slack/callback` |
| `DAILY_TOKEN_BUDGET` | Per-user daily LLM token cap, checked before a run is queued (default 50,000) |
| `TOKEN_ENCRYPTION_KEY` | Key for OAuth tokens at rest (AES-256-GCM). Falls back to `JWT_SECRET`; set it in production |
| `ALLOW_PRIVATE_HTTP` | `true` lets HTTP blocks reach localhost/private IPs (blocked by default to prevent SSRF) |

## Using it

- **Reference data** in any text field: `{{input}}` (run input), `{{llm1.output}}` (a block’s output, by its name), `{{http1.output.items.0.title}}` (paths into JSON).
- **Transform / Conditional** take a JS expression where `input` is the whole run context (`input.input`, `input.llm1.output`). They run in a `node:vm` sandbox with a 500 ms limit and no `eval`.
- **Conditional** has a green (true) and red (false) output; the branch not taken, and everything only reachable through it, is marked skipped.
- **Templates**: placeholders that don’t point at a block become variables the user fills in when using the template. API keys, tokens and auth headers are removed when saving.
- **Deploy** (needs a saved pipeline): cron schedules (with a readable preview), webhooks (`X-Webhook-Secret` header, or `X-Webhook-Signature: sha256=<HMAC of raw body>`), and REST endpoints that wait for the result.

## Checks

```bash
npm test                         # engine, sandbox, cloneGraph property test, templates,
                                 # OAuth refresh/revocation, Sheets→LLM→Gmail (stubbed Google), KB
npm run test-run -w server       # Phase 1 script: LLM → HTTP → LLM (also --swap, --cycle)
npm run smoke -- p2 p4 p5 cron   # end-to-end over HTTP against a running API + worker
```

## Architecture notes

- Runs are queued in BullMQ (`pipeline-runs`); the worker walks the DAG in topological order (Kahn) and writes a `RunEvent` per node change to Postgres, then publishes it on Redis `run:<id>`. The API’s SSE endpoint subscribes before replaying stored events, so none are missed, and always closes when the run ends.
- Sync invokes subscribe to the same channel before enqueueing and race it against `syncTimeout`.
- Cancelling publishes to `run-cancel`; the worker aborts the run before its next block.
- Node failures stop the run. Integration auth failures (missing, expired, revoked) surface as `auth_error`, and the config panel offers Reconnect.
- Run jobs get one attempt on purpose: blocks can have side effects (emails, Slack posts) that must not repeat.

### Known shortcuts (`grep -rn "shortcut:" server/src`)

- `node:vm` is not a hard isolation boundary; use `isolated-vm` or a separate process before running untrusted code from many tenants.
- The SSRF check resolves DNS once before fetching, so DNS rebinding can slip past it.
- Chunk sizes estimate tokens as 0.75 words each.
- Mock embeddings are lexical, not semantic.
