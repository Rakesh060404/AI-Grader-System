# AI Grader: complete build plan

Build the steps in order. Each step has a completion check; do not move on to the next implementation step until it passes. Steps 1–3 establish the foundation, and step 4 is the main technical risk.

## Current status (2026-10-15)

- The Gemini grading path and Dockerized upload-to-results flow were verified
  end-to-end on 2026-10-08, including both de-identified sample PDFs.
- This continuation re-ran the workspace build and type-check, the shared JWT
  tests, and all four Gemini provider tests successfully.
- The full DB-backed test suite and Docker stack could not be re-run in this
  continuation because the Docker engine is currently unavailable.
- The CI workflow is now published to GitHub. Its first run failed because
  type-check ran before the shared workspace declarations were built. The
  workflow now builds first; the rerun must pass before CI is complete.
- The user's local `.env` has a Gemini key, but the model and grading rubric
  are not configured there. The previous end-to-end test used temporary
  process-level settings; no API key or rubric was written to tracked files.

## Stage A: Foundation

- [x] **1. Local infrastructure.** Compose runs PostgreSQL, Redpanda, and MinIO, with health checks and a one-shot container that creates the S3 bucket. `.env.example` documents the infrastructure configuration and `GEMINI_API_KEY`/`GEMINI_MODEL` for grading. **Done when:** `docker compose ps` shows the three dependencies healthy, the MinIO console opens, a bucket exists, and a query connects to PostgreSQL.
- [x] **2. Shared package.** Add a Zod-validated environment/config loader, PostgreSQL pool, logger, and common types to `packages/shared`. **Done when:** one service imports `shared` and connects to PostgreSQL during startup.
- [x] **3. Database schema and migrations.** Add `users`, `upload_intents`, `submissions` (statuses `pending`, `grading`, `done`, `failed`), `grades`, and `outbox` (with `sent_at`), plus a migration runner and npm script. **Done when:** one command applies the full schema to a fresh database.

## Stage B: The grading core

- [x] **4. Standalone grading script.** Implement a plain `gradePdf(path, rubric)` function using `pdf-to-img`: render PDF pages to PNG, send images and rubric to the configured Gemini vision model, validate `{ score, feedback }` with Zod, and retry once on invalid JSON. Keep it independent of Kafka and HTTP. **Done when:** it returns sensible scores for at least two real answer sheets. Verified both sample sheets against the 10-mark rubric: 10/10 and 2/10. The API key was accepted by Google and the model returned validated output.

## Stage C: Auth and uploads

- [x] **5. Auth.** Add register, login, and refresh endpoints in the gateway, password hashing with bcrypt or argon2, and JWT access/refresh tokens. **Done when:** register, login, and refresh work with curl. Verified register/login/refresh over HTTP.
- [x] **6. JWT verification in shared.** Add reusable token verification middleware that attaches the user ID. **Done when:** a protected test route returns 401 without a token and 200 with one. Verified 401 without a token, 200 with access token, and 401 when a refresh token is used as an access token.
- [x] **7. Presign endpoint.** Add `POST /uploads/presign` in the upload service. It creates an `upload_intents` row and returns a presigned MinIO PUT URL with a file-size limit and PDF content type. **Done when:** a PDF can be PUT to the returned URL and appears in the bucket. Verified by uploading to MinIO during the local integration check.
- [x] **8. Complete endpoint.** Add `POST /uploads/:id/complete`; verify intent ownership, object existence, size, and `%PDF-` file signature. **Done when:** a valid PDF is accepted and a non-PDF renamed to `.pdf` is rejected. Verified: valid-signature object accepted; non-PDF rejected with HTTP 400; unauthenticated presign rejected with HTTP 401.

## Stage D: The event-driven pipeline

- [x] **9. Transactional outbox.** In the complete handler, insert the submission and outbox event in one database transaction. **Done when:** a forced failure after the submission insert leaves neither row committed. Verified by an integration test that forces an error after both inserts and confirms both records roll back.
- [x] **10. Kafka setup in shared.** Add producer/consumer factories, topic names, and a Redpanda topic-creation script. **Done when:** a test message flows from producer to consumer. Verified using local Redpanda.
- [x] **11. Outbox publisher.** Add an upload-service background loop that claims unsent rows with `FOR UPDATE SKIP LOCKED`, publishes them to Kafka, and marks them sent. **Done when:** completion publishes an event, and an event remains deliverable after Kafka is stopped for a minute and restarted. Verified an upload event remained unsent during a 60-second Redpanda stop and was published and consumed after broker recovery.
- [x] **12. Grader service.** Consume submission events, fetch each PDF from S3, call `gradePdf`, and persist results in `grades`. **Done when:** completing an upload leads to a grade row without manual steps. Verified a live Gemini grade was persisted and retrieved through the results API.
- [x] **13. Idempotency, statuses, and failure handling.** Skip submissions already `done`; transition through `pending`, `grading`, `done`, and `failed`; add bounded retries and persist a failure reason. **Done when:** duplicate messages create one grade and a bad PDF ends in `failed` with a reason. Verified one grade for duplicate events, three bounded attempts, and failed status/reason for invalid PDF bytes.
- [x] **14. Results service.** Add `GET /results` for the user's submissions and `GET /results/:id`, scoped to the JWT user. **Done when:** polling works and a second user receives 404 or 403 for another user's result. Verified via gateway list/detail and cross-user 404.
- [x] **15. Gateway proxy.** Route `/auth`, `/uploads`, and `/results` to the responsible services. Verify JWTs at the gateway and again in downstream services. **Done when:** the full flow works through the gateway and direct unauthenticated service calls fail. Verified upload completion and result retrieval through the gateway; unauthenticated direct upload call returned 401.

### End-to-end checkpoint

- [x] Register, log in, presign, upload, complete, wait for grading, and fetch the grade. Verified end-to-end through the gateway using a real sample PDF and live Gemini grading.

## Stage E: Make it production-like

- [ ] **16. Dockerize the services.** Add multi-stage Dockerfiles for each service and shared migration/topic setup and include them in Compose. Images built; Compose migrations/topic setup, health checks, non-root API containers, and the Dockerized upload-to-Gemini-to-results flow were verified on 2026-10-08. The acceptance check specifically says a clean machine; a fresh-volume startup was not attempted, and existing local data volumes were deliberately preserved. The Docker engine is currently unavailable, so this final clean-environment check remains.
- [x] **17. Tests.** Focus on the outbox transaction, idempotent grader, and JWT validation. **Done when:** `npm test` passes. Integration tests cover outbox rollback, access-token validation, duplicate grading, bounded retries, and invalid PDF failure.
- [ ] **18. CI.** Add a GitHub Actions workflow for install, type-check, build, migration, and tests. Workflow is published at `.github/workflows/ci.yml`; local build and type-check pass, along with the shared JWT and Gemini provider tests. The first GitHub Actions run failed because workspace packages had not been built before downstream type-checks. The workflow order is fixed to build before type-check; verify the new run. DB-backed tests passed previously, but could not be re-run locally now because Docker is unavailable. **Next:** confirm the fixed workflow run succeeds on `main`.
- [x] **19. Documentation.** Complete the README with a Mermaid architecture diagram, setup instructions, API list, design decisions (outbox, Kafka, presigned uploads), and known limitations. Add the demo and interview notes. **Done when:** another developer can run the project from the README alone.
- [ ] **20. Demo and placement material.** Record a 1–2 minute demo, write resume bullets, and prepare interview answers on outbox, idempotency, and presigned uploads. A recording outline, resume bullet drafts, and interview notes are ready in `docs/DEMO.md`. **Remaining:** record the demo and tailor resume bullets with the user's actual experience and measured results.

## Next actions

1. Configure `GEMINI_MODEL` and `GRADING_RUBRIC` in the local `.env` (keep
   credentials private).
2. When Docker is available, verify Compose startup from a fresh, isolated
   project/volume so existing local data is not deleted.
3. Confirm the fixed GitHub Actions workflow run is green on `main`.
4. Record the short demo using de-identified sample data.

## If time runs short

Defer in this order: CI (18), tests (17), refresh tokens in auth (5), the separate results service (14; fold results into upload), then downstream JWT re-validation (15). Do not cut grading core (4), presigned uploads (7), completion validation (8), the outbox and event pipeline (9–13), or the multi-service split.

## Main risks

- PDF rendering and unreliable model JSON make step 4 the primary technical risk; implement and validate it early.
- Steps 9–11 require careful reasoning about atomicity, duplicate publication, and recovery. Understand and explain these paths rather than treating generated code as a black box.
- Step 13 is a likely source of bugs. Test duplicate delivery and deliberately interrupt grading mid-job.
