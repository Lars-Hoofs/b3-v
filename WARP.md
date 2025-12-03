# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Overview

This repo is a TypeScript/Node.js backend for an enterprise-grade AI customer support platform. It exposes an Express-based HTTP API, uses Prisma with PostgreSQL (and pgvector) for persistence, Redis for rate limiting and background features, Better-auth for authentication, and OpenAI/Resend for AI and email functionality. The main domain concepts are:

- **Users & Workspaces** with roles and membership
- **Agents & Widgets** for embeddable chat experiences
- **Conversations & Messages** with media attachments
- **Knowledge Bases & Documents** with vector embeddings
- **Scrape Jobs** for ingesting external content
- **Node-based Workflows** for orchestrating AI/human actions in conversations

## Core Commands

All commands are run from the repo root.

### Local development

- Install dependencies:
  - `npm install`
- Start the dev server (TS with live reload):
  - `npm run dev`
- Start the compiled server (after build):
  - `npm start`

### Build

- Generate Prisma client and compile TypeScript to `dist/`:
  - `npm run build`

### Prisma & database

- Generate Prisma client only:
  - `npm run prisma:generate`
- Run dev migrations (uses `prisma migrate dev` against the `DATABASE_URL` in env):
  - `npm run prisma:migrate`
- Open Prisma Studio:
  - `npm run prisma:studio`

### Docker-based stack

Docker is used to run PostgreSQL, Redis, and the API.

- Start Postgres + Redis + API stack in dev profile:
  - `npm run docker:dev`
- Start Prisma Studio container in the same stack:
  - `npm run docker:studio`
- Stop the dev stack:
  - `npm run docker:stop`
- Tail Prisma Studio logs:
  - `npm run docker:logs`

### Tests and linting

There are currently no explicit test or lint scripts defined in `package.json`. If you add Jest/Vitest/ESLint later, define `test`, `test:watch`, and `lint` scripts and update this section accordingly.

## Runtime & Environment

### Entry point and server lifecycle

- The main entry point is `src/index.ts`.
- It:
  - Loads environment variables via `dotenv` and validates them through `src/lib/env.ts`.
  - Configures Express with `helmet`, `cors`, JSON/body parsers, and a custom `requestLogger` middleware.
  - Sets up Redis-backed rate limiters for `/api/` and specific scraping routes.
  - Mounts Better-auth on `/api/auth` via a `fetch`-style handler.
  - Serves a public `widget.js` script built by `generateWidgetScript` from `src/services/widget.service.ts`.
  - Mounts feature routes (workspaces, invites, users, agents, widgets, chat, workflows, knowledge bases, media, scraper, dashboard, presence, superadmin).
  - Initializes Socket.io via `src/services/socket.service.ts`.
  - Exposes `/health` for health checks.
  - Implements a global 404 and error handler.
  - Implements graceful shutdown: closes HTTP, disconnects Prisma and Redis, and exits on `SIGINT`/`SIGTERM`.

### Environment validation (`src/lib/env.ts`)

Environment variables are validated with Zod:

- **Required**
  - `DATABASE_URL` (PostgreSQL connection)
  - `BETTER_AUTH_SECRET` (≥ 32 chars)
  - `BETTER_AUTH_URL` (URL of auth frontend/backend)
  - `PORT` (coerced to number, default 3000)
  - `NODE_ENV` (`development` | `production` | `test`, default `development`)
  - `OPENAI_API_KEY` (must start with `sk-`)
  - `RESEND_API_KEY` (must start with `re_`)
- **Defaults / optional**
  - `REDIS_URL` (default `redis://localhost:6379`)
  - `EMAIL_FROM` (defaults to `noreply@yourdomain.com`)
  - `LOG_LEVEL` (`error` | `warn` | `info` | `debug`, default `info`)

If validation fails, the process logs each invalid field and exits with non-zero.

### Logging (`src/lib/logger.ts`)

- Uses Winston with daily-rotating file transports under `logs/`.
- In `development`, logs are also sent to the console with colorized, human-readable formatting.
- Default metadata includes `service: 'ai-chat-platform'` and `environment`.
- Separate rotating logs exist for application, error, unhandled exceptions, and unhandled rejections.

## High-level Architecture

### Directory structure (high level)

- `src/index.ts` – application bootstrap and HTTP server.
- `src/lib/` – shared infrastructure/utilities:
  - `auth.ts` – Better-auth integration and handler.
  - `circuitBreaker.ts` – resilience utilities for external calls.
  - `email.ts` – email sending via Resend.
  - `env.ts` – environment loading/validation and exported `env` object.
  - `errors.ts` – central error types/helpers.
  - `logger.ts` – Winston logger instance.
  - `openai.ts` – OpenAI API client wrapper.
  - `prisma.ts` – Prisma client singleton.
  - `redis.ts`, `redisLock.ts` – Redis client and distributed locking primitives.
  - `tokenCounter.ts` – OpenAI token counting.
  - `transaction.ts` – database transaction helpers.
  - `workflowLoopDetector.ts`, `workflowStateManager.ts` – workflow engine support utilities.
- `src/middleware/` – cross-cutting Express middleware:
  - `auth.middleware.ts` – attaches auth info and `requireAuth` guard.
  - `rateLimits.ts` – Redis-backed rate limiters for auth, generic API, and scraping endpoints.
  - `requestLogger.ts` – structured request logging using `logger`.
  - `validation.ts` – request validation helpers (Zod-based).
- `src/routes/` – Express routers organized by domain; all under `/api/*` except `widget.js`:
  - `workspace.routes.ts` – CRUD and membership endpoints for workspaces.
  - `invite.routes.ts` – invite issuance, acceptance, and status.
  - `user.routes.ts` – user/profile endpoints.
  - `auth-helper.routes.ts` – helper endpoints around auth flows.
  - `agent.routes.ts` – CRUD and configuration for AI agents.
  - `widget.routes.ts` – widget configuration for embeddable chat.
  - `chat.routes.ts` – conversation/message endpoints.
  - `workflow.routes.ts` – workflow CRUD, node/edge management, and execution.
  - `knowledgeBase.routes.ts` – KB and document management.
  - `media.routes.ts` – uploaded file/media handling (loaded dynamically).
  - `scraper.routes.ts` – website/URL scraping and job control.
  - `dashboard.routes.ts` – analytics and dashboard data.
  - `presence.routes.ts` – agent presence/status APIs.
  - `superadmin.routes.ts` – elevated/admin-only operations.
- `src/services/` – domain and integration services with business logic:
  - `*.service.ts` files roughly match the route files (agent, analytics, audit, chat, invite, knowledgeBase, media, presence, scraper, socket, user, webhook, widget, workflow, workspace).
  - `workflow.executors.ts`, `workflow.logger.ts`, `workflow.types.ts`, `workflowExecutor.service.ts` – core of the node-based workflow engine.
- `src/types/` – shared domain types (e.g., `chat.types.ts`, workflow-related types).
- `prisma/schema.prisma` – full relational model for users, workspaces, auth, conversations, media, knowledge base, scraping, and workflows, using pgvector for document embeddings.

### Request flow (HTTP API)

1. **Inbound HTTP**
   - Requests hit `src/index.ts` and are processed by global middleware (Helmet, CORS, JSON body parsing, request logging, rate limiting).
2. **Authentication**
   - Authenticated routes use `requireAuth` from `auth.middleware.ts`, which validates Better-auth sessions and populates the request with user/workspace context.
3. **Routing**
   - Each domain router in `src/routes/*` validates input (often via Zod), then delegates to a corresponding service function.
4. **Services & data access**
   - Services in `src/services/*` encapsulate business logic and talk to:
     - `prisma` for DB access.
     - `redis` for caching/locks/rate limiting where appropriate.
     - External APIs (OpenAI, Resend, scraping via Puppeteer/Cheerio, etc.).
5. **Error handling & logging**
   - Service-level errors often throw custom error types (e.g., `WorkflowError`) with HTTP-aware status codes.
   - The global error handler logs details via `logger` and converts known errors into structured JSON responses.

### Workflow engine (node-based orchestration)

- **Persistence** (in `prisma/schema.prisma`):
  - `Workflow` – top-level workflow definition, with `startNodeIds` referencing `WorkflowNode` records.
  - `WorkflowNode` – typed nodes with JSON `config` and positional metadata.
  - `WorkflowEdge` – directed edges with optional JSON `condition`.
  - `WorkflowExecution` – per-run state, including `executionData`, `status`, `currentNodeId`, error and logs.
- **HTTP interface** (`src/routes/workflow.routes.ts`):
  - Full CRUD for workflows (`create`, `get`, `update`, `delete`, `toggle active`).
  - Node and edge creation/update/delete.
  - `/:workflowId/batch-save` to atomically replace all nodes/edges and configure start nodes from a visual editor (React Flow IDs mapped to DB IDs).
  - `/:id/execute` to run a workflow for an optional `conversationId` and `initialData`.
- **Execution logic** (`src/services/workflow.service.ts` + executors):
  - Validates workspace ownership/visibility on each operation.
  - Uses `WorkflowLogger` for structured per-execution logs.
  - Selects entry nodes via `workflow.startNodeIds` or nodes without incoming edges.
  - Executes nodes depth-first along outgoing edges, evaluating per-node and per-edge conditions via `evaluateCondition` (supports equals/notEquals/contains/greaterThan/lessThan/exists/matches, with optional negation and nested variable paths).
  - Supports retry, timeout, conditional execution, and `continueOnError`/`saveResultAs` semantics via `BaseNodeConfig`.
  - Delegates actual behavior to `workflow.executors.ts`, which covers triggers, conditions, actions (messages, email, API calls, variable set, delays), AI operations (LLM responses, KB search, intent classification, summarization), flow control (loops), and data transforms/validation.

### Conversations, knowledge base, and scraping (data model)

The Prisma schema also defines:

- **Conversations & messages**
  - `Conversation` – conversation session with visitor identity, assignment, status, dashboard visibility, workflow state, timestamps, and soft delete.
  - `Message` – individual messages with role (user/assistant/agent/system), content, metadata (tokens, latency), sender linkage, and attachments.
  - `MediaAttachment` – file/asset details for message attachments.
- **Knowledge base**
  - `KnowledgeBase` – configuration for embeddings, chunking, and lifecycle.
  - `Document` – KB documents with content, processing status, chunk counts, and metadata.
  - `DocumentChunk` – text chunks with pgvector embeddings for semantic search.
- **Scrape jobs**
  - `ScrapeJob` – tracks long-running scraping tasks, URL sets, counters, status, and errors for ingesting web content into KBs.

## How to extend or debug

- **Adding new routes/features**
  - Prefer adding a new `*.routes.ts` under `src/routes/` and a corresponding `*.service.ts` under `src/services/`.
  - Wire the new router into `src/index.ts` under the `/api/*` namespace, and integrate with existing middleware (auth, rate limits, validation patterns).
- **Working on workflows**
  - For schema-level changes, update `prisma/schema.prisma`, run `npm run prisma:migrate`, then `npm run prisma:generate`.
  - For new node types or behaviors, extend `NodeType` in the Prisma schema, add handlers in `workflow.executors.ts`, and map the string type in `executeNodeByType`.
- **Troubleshooting**
  - Use `/health` and logs under `logs/` to understand runtime issues.
  - For workflow issues, inspect `workflow_executions` and logs produced by `WorkflowLogger` (see `workflow.logger.ts`) and consider instrumenting services with `logger`.
