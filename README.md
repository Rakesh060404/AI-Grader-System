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

Before calling the grading function, replace the `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` placeholders in `.env` with valid values. The grading function sends rendered answer-sheet pages and the rubric to that configured OpenRouter model.

Check that PostgreSQL accepts a query:

```sh
docker compose exec -T postgres psql -U grader -d grader -c "SELECT 1;"
```

MinIO's console is available at `http://localhost:9001` with the local root credentials from `.env`.

Apply the database migrations after the local PostgreSQL service is healthy:

```sh
npm run db:migrate
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

The gateway reads `.env` from the repository root. The service and shared package directories are being implemented in the order listed in `docs/PLAN.md`.
