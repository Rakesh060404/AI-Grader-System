# AI Grader project context

Build an event-driven AI exam grader as a TypeScript and Node.js monorepo using Fastify.
The planned services are:

- `gateway`: the client-facing API and request routing.
- `upload`: submission upload coordination, object storage, and submission completion.
- `grader`: asynchronous PDF grading and persistence of grades.
- `results`: authenticated grade and feedback retrieval.
- `packages/shared`: shared database, authentication, messaging, storage, and type utilities.

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the intended request flow and data model.
See [docs/PLAN.md](../docs/PLAN.md) for the implementation checklist.

## Planned stack

- TypeScript with strict compiler settings and Node.js.
- Fastify for HTTP services and Zod for request and external-response validation.
- PostgreSQL accessed with `pg`.
- Kafka-compatible event transport using Redpanda and `kafkajs`.
- S3-compatible object storage using MinIO locally and `@aws-sdk/client-s3`.
- JWT handling with `jose`.
- Vision-capable grading model accessed through the Gemini API.

Treat this stack as the project direction; do not assume that a dependency or service is already configured until it appears in the repository.

## Engineering rules

- Use strict TypeScript. Avoid `any`; model external data as `unknown` and validate it.
- Validate HTTP inputs and AI-provider responses with Zod.
- Read credentials and environment-specific settings from environment variables. Never hardcode or log secrets.
- Keep service boundaries explicit. Put genuinely shared code and types in `packages/shared`.
- Insert a submission and its outbox event in the same PostgreSQL transaction.
- Publish outbox events so a process crash can cause redelivery without losing the event. Make consumers idempotent; do not assume Kafka delivery is exactly once.
- Enforce one persisted grade per submission with a database uniqueness constraint as well as an application-level idempotency check.
- Make failure states and retry behavior explicit. Do not silently substitute defaults for invalid configuration or malformed provider responses.
- Keep functions focused and follow existing repository naming, formatting, error-handling, and test patterns.
- Add or update tests and the relevant API or architecture documentation with behavior changes.
- Do not add dependencies without asking first.
