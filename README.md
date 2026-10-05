# AI Grader

An event-driven AI exam grader built as a TypeScript monorepo. The architecture and implementation checklist are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PLAN.md](docs/PLAN.md).

## Prerequisites

- Node.js 22 or later and npm
- Docker with the Compose plugin

## Local infrastructure

Copy `.env.example` to `.env` to configure the local-only defaults, then start the dependencies:

```sh
Copy-Item .env.example .env
docker compose up -d
docker compose ps
```

Services:

- PostgreSQL: `localhost:5432`
- Redpanda Kafka API: `localhost:19092` (internal Compose address: `redpanda:9092`)
- MinIO S3 API: `localhost:9000`; console: `http://localhost:9001`
- MinIO bucket: `ai-grader-submissions` (created automatically by the one-shot `minio-init` container)

The checked-in example credentials are for local development only. Do not use them in shared or production environments. `.env.example` uses host-accessible endpoints for running Node.js directly; when app containers are introduced, they must use the Compose service hostnames (`postgres`, `redpanda`, and `minio`).

The local Compose setup currently uses the archived `bitnamilegacy/minio` image to provide MinIO-compatible development storage. It is for local prototyping only; select a currently supported MinIO distribution before using this setup outside local development.

Before running the grader, replace `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `GRADING_RUBRIC` in `.env` with valid values. The grader sends rendered answer-sheet pages and the rubric to the configured OpenRouter model.

Check that PostgreSQL accepts a query:

```sh
docker compose exec -T postgres psql -U grader -d grader -c "SELECT 1;"
```

MinIO's console is available at `http://localhost:9001` with the local root credentials from `.env`.

Apply the database migrations after the local PostgreSQL service is healthy:

```sh
npm run db:migrate
npm run kafka:create-topics
```

## Workspace

Install the workspace dependencies and build or type-check all packages:

```sh
npm install
npm run build
npm run typecheck
```

To verify the gateway imports the shared package and connects to PostgreSQL on startup:

```sh
npm run start --workspace=@ai-grader/gateway
```

The gateway reads `.env` from the repository root. `UPLOAD_SERVICE_URL` and
`RESULTS_SERVICE_URL` configure gateway proxy destinations. For local host
development, start services in separate terminals after building:

```sh
npm run start --workspace=@ai-grader/upload
npm run start --workspace=@ai-grader/grader
npm run start --workspace=@ai-grader/results
npm run start --workspace=@ai-grader/gateway
```

The grader requires a usable OpenRouter API key, model ID, and grading rubric.
Without them it will fail configuration validation or provider requests rather
than silently return a made-up grade.

## Tests

With PostgreSQL, Redpanda, MinIO, and the migration schema available:

```sh
npm test
```

API paths and request/response examples are documented in [docs/API.md](docs/API.md).
To run the upload service directly after building the workspace, use:

```sh
npm run build --workspace=@ai-grader/upload
npm run start --workspace=@ai-grader/upload
```

The upload API listens on `http://localhost:3001` by default. It validates and
completes upload intents, writes submissions and outbox events transactionally,
and publishes those events to Redpanda. The gateway proxies upload and results
routes while the downstream services independently verify access tokens.
