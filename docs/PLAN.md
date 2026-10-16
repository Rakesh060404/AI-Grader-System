# AI Grader: complete build plan

Build the steps in order. Each step has a completion check; do not move on to the next implementation step until it passes. Steps 1–3 establish the foundation, and step 4 is the main technical risk.

## Current status (2026-10-16)

- The full Dockerized gateway-to-results flow now passes with
  `gemini-3.5-flash-lite`: both de-identified sample PDFs were uploaded,
  graded, persisted, and retrieved. The observed scores were 10/10 and 3/10.
- The previous `gemini-2.5-flash` model is unavailable to new users and
  `gemini-3.8-flash` returned HTTP 503 during high demand. A lightweight model
  returned HTTP 200 and completed both full vision grading requests.
- Fixed the local `.env` key name to `GEMINI_API_KEY` (preserving its value)
  and added the missing host-run service URLs. The key and rubric remain local
  and are not tracked.
- Standalone runtime validation passed all six checks: workspace build,
  type-check, tests, and gateway/upload/results health endpoints. The root test
  script exited successfully; the validation runner could not parse aggregate
  TAP counts from the nested workspace scripts.
- GitHub Actions run [#6](https://github.com/Rakesh060404/AI-Grader-System/actions/runs/38777300134)
  passed on `main`, including install, build, type-check, migrations, and tests.

## Stage A: Foundation

- [x] **1. Local infrastructure.** Compose runs PostgreSQL, Redpanda, and MinIO, with health checks and a one-shot container that creates the S3 bucket. `.env.example` documents the infrastructure configuration and `GEMINI_API_KEY`/`GEMINI_MODEL` for grading. **Done when:** `docker compose ps` shows the three dependencies healthy, the MinIO console opens, a bucket exists, and a query connects to PostgreSQL.
- [x] **2. Shared package.** Add a Zod-validated environment/config loader, PostgreSQL pool, logger, and common types to `packages/shared`. **Done when:** one service imports `shared` and connects to PostgreSQL during startup.
- [x] **3. Database schema and migrations.** Add `users`, `upload_intents`, `submissions` (statuses `pending`, `grading`, `done`, `failed`), `grades`, and `outbox` (with `sent_at`), plus a migration runner and npm script. **Done when:** one command applies the full schema to a fresh database.

## Stage B: The grading core

- [x] **4. Standalone grading script.** Implement a plain `gradePdf(path, rubric)` function using `pdf-to-img`: render PDF pages to PNG, send images and rubric to the configured Gemini vision model, validate `{ score, feedback }` with Zod, and retry once on invalid JSON. Keep it independent of Kafka and HTTP. **Done when:** it returns sensible scores for at least two real answer sheets. Verified both de-identified samples through the full gateway-to-results flow with the configured 10-mark rubric and `gemini-3.5-flash-lite`: scores 10/10 and 3/10, with grades persisted and returned.

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

- [x] **16. Dockerize the services.** Add multi-stage Dockerfiles for each service and shared migration/topic setup and include them in Compose. Verified fresh-volume startup: migrations applied, Kafka topic setup completed, APIs became healthy, and app containers ran as non-root. Verified the normal Compose stack and complete live grading flow on 2026-10-16.
- [x] **17. Tests.** Focus on the outbox transaction, idempotent grader, and JWT validation. **Done when:** `npm test` passes. The full local test script and CI passed, including outbox rollback, access-token validation, duplicate grading, bounded retries, and invalid-PDF failure.
- [x] **18. CI.** Add a GitHub Actions workflow for install, type-check, build, migration, and tests. Workflow at `.github/workflows/ci.yml` passed on `main` in [run #6](https://github.com/Rakesh060404/AI-Grader-System/actions/runs/38777300134). The first run found and exposed a build-order issue; the workflow now builds workspace declarations before type-checking dependent services.
- [x] **19. Documentation.** Complete the README with a Mermaid architecture diagram, setup instructions, API list, design decisions (outbox, Kafka, presigned uploads), and known limitations. Add the demo and interview notes. **Done when:** another developer can run the project from the README alone.
- [ ] **20. Demo and placement material.** Record a 1–2 minute demo, write resume bullets, and prepare interview answers on outbox, idempotency, and presigned uploads. A recording outline, resume bullet drafts, and interview notes are ready in `docs/DEMO.md`. **Remaining:** record the demo and tailor resume bullets with the user's actual experience and measured results.

## Next actions

1. Record the 1–2 minute demo using de-identified samples; the live flow has
   now been verified with two samples.
2. Replace the generic sample rubric with the course rubric before grading
   real submissions, and confirm the configured Gemini model/quota remain
   available.
3. Tailor the resume bullets with the user's actual contributions and measured
   project impact.

## If time runs short

Defer in this order: CI (18), tests (17), refresh tokens in auth (5), the separate results service (14; fold results into upload), then downstream JWT re-validation (15). Do not cut grading core (4), presigned uploads (7), completion validation (8), the outbox and event pipeline (9–13), or the multi-service split.

## Main risks

- PDF rendering and unreliable model JSON make step 4 the primary technical risk; implement and validate it early.
- Steps 9–11 require careful reasoning about atomicity, duplicate publication, and recovery. Understand and explain these paths rather than treating generated code as a black box.
- Step 13 is a likely source of bugs. Test duplicate delivery and deliberately interrupt grading mid-job.
