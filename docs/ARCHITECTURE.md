# AI Grader architecture

## Scope and assumptions

This document describes the intended first implementation of an event-driven exam-grading system. It is a design baseline, not a claim that the services or infrastructure have already been implemented.

- Clients authenticate with a JWT and submit exam PDFs.
- The upload service issues short-lived S3 presigned upload URLs. PDF bytes go directly from the client to object storage.
- Completing an upload records the submission and a `submission.completed` outbox event in one PostgreSQL transaction.
- An outbox publisher forwards pending events to Kafka (Redpanda in local development).
- The grader consumes events, retrieves the PDF, calls a vision-capable model through OpenRouter, validates the result, and stores a grade.
- The results service returns grades only to an authorized caller.
- MinIO is the local S3-compatible store. Production provider and deployment choices remain configurable.

## Component responsibilities

| Component | Responsibility |
|---|---|
| Client | Requests an upload URL, uploads the PDF to object storage, completes the submission, and reads results. |
| Gateway | Shared API entry point; applies request-level authentication and routes to internal services. |
| Upload service | Validates upload requests, issues presigned URLs, verifies completion metadata as appropriate, and atomically writes the submission and outbox row. |
| Outbox publisher | Claims unsent rows safely across workers, publishes events, and records successful publication for retry-safe delivery. |
| Kafka / Redpanda | Buffers submission events between upload and grading. |
| Grader service | Consumes submission events, loads the PDF, invokes the configured grading model, validates the response, and persists the grade idempotently. |
| Results service | Authenticates and authorizes result lookups and returns persisted score and feedback. |
| PostgreSQL | Stores submissions, outbox events, and grades. |
| S3-compatible storage | Stores uploaded PDFs; only object keys, not document contents, belong in the relational database. |
| OpenRouter | Routes the grader's request to the vision-capable model configured by `OPENROUTER_MODEL`; the model name and API key are environment configuration, not source-code constants. |

## Submission-to-results flow

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Gateway
    participant Upload as Upload service
    participant DB as PostgreSQL
    participant Store as S3 / MinIO
    participant Outbox as Outbox publisher
    participant Kafka as Kafka / Redpanda
    participant Grader
    participant Model as OpenRouter vision model
    participant Results as Results service

    Client->>Gateway: Request presigned upload URL (JWT)
    Gateway->>Upload: Validate and authorize request
    Upload-->>Client: Presigned URL and submission ID
    Client->>Store: PUT PDF using presigned URL
    Client->>Gateway: Complete submission (JWT)
    Gateway->>Upload: Complete submission
    Upload->>DB: BEGIN; insert submission + outbox event; COMMIT
    Upload-->>Client: Accepted
    Outbox->>DB: Claim pending rows (FOR UPDATE SKIP LOCKED)
    Outbox->>Kafka: Publish submission.completed
    Outbox->>DB: Mark event published
    Kafka-->>Grader: Deliver submission.completed
    Grader->>DB: Check whether submission already has a grade
    Grader->>Store: Read PDF by object key
    Grader->>Model: Request grade with rubric and PDF pages
    Model-->>Grader: Candidate score and feedback
    Grader->>Grader: Validate response against schema
    Grader->>DB: Insert grade (unique submission ID)
    Client->>Gateway: Request results (JWT)
    Gateway->>Results: Authorize and fetch result
    Results->>DB: Read grade for submission
    Results-->>Client: Score, feedback, and status
```

The outbox closes the database/Kafka dual-write gap: a committed submission always has a durable event to publish. Publication is at least once because a process can fail after Kafka accepts an event but before PostgreSQL records it as published. The grader therefore must tolerate duplicate delivery. A database uniqueness constraint on `grades.submission_id` is the final safeguard against duplicate grades.

## Initial relational schema

The following PostgreSQL schema is the planned starting point for migration step 3. Use migrations as the source of truth and adapt names or fields only with corresponding changes to the services and API documentation.

```sql
CREATE TABLE users (
    id             uuid PRIMARY KEY,
    email          text NOT NULL UNIQUE,
    password_hash  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE upload_intents (
    id             uuid PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id),
    object_key     text NOT NULL UNIQUE,
    content_type   text NOT NULL CHECK (content_type = 'application/pdf'),
    max_size_bytes bigint NOT NULL CHECK (max_size_bytes > 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CHECK (expires_at > created_at)
);

CREATE INDEX upload_intents_user_expiry_idx
    ON upload_intents (user_id, expires_at);

CREATE TABLE submissions (
    id               uuid PRIMARY KEY,
    user_id          uuid NOT NULL REFERENCES users(id),
    upload_intent_id uuid NOT NULL UNIQUE REFERENCES upload_intents(id),
    object_key       text NOT NULL UNIQUE,
    status           text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'grading', 'done', 'failed')),
    failure_reason   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_user_created_idx
    ON submissions (user_id, created_at DESC);

CREATE TABLE outbox (
    id             uuid PRIMARY KEY,
    submission_id  uuid NOT NULL REFERENCES submissions(id),
    event_type     text NOT NULL,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    sent_at        timestamptz,
    attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX outbox_unsent_idx ON outbox (created_at, id)
    WHERE sent_at IS NULL;

CREATE TABLE grades (
    id             uuid PRIMARY KEY,
    submission_id  uuid NOT NULL UNIQUE REFERENCES submissions(id),
    score          numeric NOT NULL CHECK (score >= 0),
    feedback       jsonb NOT NULL,
    model          text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
```

`feedback` should be validated before insertion and returned in a documented API shape (for example, a list of criterion-level comments). Add score upper-bound validation once the exam/rubric model defines the maximum. Keep model response text or provider diagnostics out of the public result unless explicitly needed and reviewed for privacy.

### Outbox and consumer rules

- In a single database transaction, insert the `submissions` row and its `outbox` row.
- Claim pending outbox rows in a transaction using `FOR UPDATE SKIP LOCKED`; commit the claim before network I/O if using a lease/claim field, or hold locks only for a short, bounded operation. Do not hold a database transaction open during an unbounded Kafka call.
- Record publication only after Kafka acknowledges the event. If publication succeeds but recording fails, allow a duplicate event on retry.
- Include a stable event ID, submission ID, event type, and schema version in each event. Do not include PDF bytes, credentials, or unnecessary personal data.
- Commit the Kafka consumer offset only after the grade is durably stored (or the event is explicitly classified as permanently invalid). Retry transient failures; make poison-event handling observable.
- Check for an existing grade before expensive grading work and rely on the unique constraint to handle concurrent duplicate deliveries.

## Initial API outline

Exact routes and payloads must be recorded in `docs/API.md` when the API is implemented.

| Operation | Purpose | Expected result |
|---|---|---|
| Request upload | Create/authorize a submission and obtain a short-lived presigned URL. | Submission ID and upload URL. |
| Complete upload | Confirm uploaded object and persist submission plus outbox event. | Accepted submission with a grading status. |
| Get result | Return the caller-authorized submission status and, when ready, score and feedback. | Status and optional grade. |

All externally supplied identifiers and payloads require validation and authorization. Presigned URLs are bearer capabilities: keep their lifetime short and do not log them.

## Operational and security considerations

- Keep database, Kafka, object-store, and model credentials in environment-specific secret storage; commit only safe placeholders in `.env.example`.
- Configure timeouts and bounded retries for Kafka, object storage, and model calls. Surface exhausted retries and permanent failures through logs/metrics without logging tokens, presigned URLs, or exam contents.
- Restrict object access to the relevant service identities and use opaque object keys.
- Enforce ownership/role checks in the results path; possession of a submission ID is not authorization.
- Define PDF size/page limits and validate actual file type/content rather than relying only on the filename or client MIME type.
- Make service health/readiness checks distinguish process health from dependency readiness.
