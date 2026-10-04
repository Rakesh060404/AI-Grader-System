# AI Grader: complete build plan

Build the steps in order. Each step has a completion check; do not move on to the next implementation step until it passes. Steps 1–3 establish the foundation, and step 4 is the main technical risk.

## Stage A: Foundation

- [x] **1. Local infrastructure.** Compose runs PostgreSQL, Redpanda, and MinIO, with health checks and a one-shot container that creates the S3 bucket. `.env.example` documents `DATABASE_URL`, `KAFKA_BROKERS`, `S3_ENDPOINT`, `S3_BUCKET`, `JWT_SECRET`, and `OPENROUTER_API_KEY`. **Done when:** `docker compose ps` shows the three dependencies healthy, the MinIO console opens, a bucket exists, and a query connects to PostgreSQL.
- [x] **2. Shared package.** Add a Zod-validated environment/config loader, PostgreSQL pool, logger, and common types to `packages/shared`. **Done when:** one service imports `shared` and connects to PostgreSQL during startup.
- [x] **3. Database schema and migrations.** Add `users`, `upload_intents`, `submissions` (statuses `pending`, `grading`, `done`, `failed`), `grades`, and `outbox` (with `sent_at`), plus a migration runner and npm script. **Done when:** one command applies the full schema to a fresh database.

## Stage B: The grading core

- [ ] **4. Standalone grading script.** Implement a plain `gradePdf(path, rubric)` function using `pdf-to-img`: render PDF pages to PNG, send images and rubric to the configured OpenRouter vision model, validate `{ score, feedback }` with Zod, and retry once on invalid JSON. Keep it independent of Kafka and HTTP. **Done when:** it returns sensible scores for at least two real answer sheets.

## Stage C: Auth and uploads

- [ ] **5. Auth.** Add register, login, and refresh endpoints in the gateway, password hashing with bcrypt or argon2, and JWT access/refresh tokens. **Done when:** register, login, and refresh work with curl.
- [ ] **6. JWT verification in shared.** Add reusable token verification middleware that attaches the user ID. **Done when:** a protected test route returns 401 without a token and 200 with one.
- [ ] **7. Presign endpoint.** Add `POST /uploads/presign` in the upload service. It creates an `upload_intents` row and returns a presigned MinIO PUT URL with a file-size limit and PDF content type. **Done when:** a PDF can be PUT to the returned URL and appears in the bucket.
- [ ] **8. Complete endpoint.** Add `POST /uploads/:id/complete`; verify intent ownership, object existence, size, and `%PDF-` file signature. **Done when:** a valid PDF is accepted and a non-PDF renamed to `.pdf` is rejected.

## Stage D: The event-driven pipeline

- [ ] **9. Transactional outbox.** In the complete handler, insert the submission and outbox event in one database transaction. **Done when:** a forced failure after the submission insert leaves neither row committed.
- [ ] **10. Kafka setup in shared.** Add producer/consumer factories, topic names, and a Redpanda topic-creation script. **Done when:** a test message flows from producer to consumer.
- [ ] **11. Outbox publisher.** Add an upload-service background loop that claims unsent rows with `FOR UPDATE SKIP LOCKED`, publishes them to Kafka, and marks them sent. **Done when:** completion publishes an event, and an event remains deliverable after Kafka is stopped for a minute and restarted.
- [ ] **12. Grader service.** Consume submission events, fetch each PDF from S3, call `gradePdf`, and persist results in `grades`. **Done when:** completing an upload leads to a grade row without manual steps.
- [ ] **13. Idempotency, statuses, and failure handling.** Skip submissions already `done`; transition through `pending`, `grading`, `done`, and `failed`; add bounded retries and persist a failure reason. **Done when:** duplicate messages create one grade and a bad PDF ends in `failed` with a reason.
- [ ] **14. Results service.** Add `GET /results` for the user's submissions and `GET /results/:id`, scoped to the JWT user. **Done when:** polling works and a second user receives 404 or 403 for another user's result.
- [ ] **15. Gateway proxy.** Route `/auth`, `/uploads`, and `/results` to the responsible services. Verify JWTs at the gateway and again in downstream services. **Done when:** the full flow works through the gateway and direct unauthenticated service calls fail.

### End-to-end checkpoint

- [ ] Register, log in, presign, upload, complete, wait for grading, and fetch the grade. This must work before starting Stage E.

## Stage E: Make it production-like

- [ ] **16. Dockerize the services.** Add a multi-stage Dockerfile per service and include services in Compose. **Done when:** `docker compose up` on a clean machine runs the whole system.
- [ ] **17. Tests.** Focus on the outbox transaction, idempotent grader, and JWT validation. **Done when:** `npm test` passes.
- [ ] **18. CI.** Add a GitHub Actions workflow for install, type-check, build, and tests. **Done when:** it passes on the main branch.
- [ ] **19. Documentation.** Complete the README with a Mermaid architecture diagram, setup instructions, API list, design decisions (outbox, Kafka, presigned uploads), and known limitations. **Done when:** another developer can run the project from the README alone.
- [ ] **20. Demo and placement material.** Record a 1–2 minute demo, write resume bullets, and prepare interview answers on outbox, idempotency, and presigned uploads.

## If time runs short

Defer in this order: CI (18), tests (17), refresh tokens in auth (5), the separate results service (14; fold results into upload), then downstream JWT re-validation (15). Do not cut grading core (4), presigned uploads (7), completion validation (8), the outbox and event pipeline (9–13), or the multi-service split.

## Main risks

- PDF rendering and unreliable model JSON make step 4 the primary technical risk; implement and validate it early.
- Steps 9–11 require careful reasoning about atomicity, duplicate publication, and recovery. Understand and explain these paths rather than treating generated code as a black box.
- Step 13 is a likely source of bugs. Test duplicate delivery and deliberately interrupt grading mid-job.
