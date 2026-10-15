# Demo and interview notes

## 1–2 minute demo outline

1. Show the architecture diagram in the README and explain the four service
   boundaries.
2. Register a user through the gateway and request an upload URL.
3. Upload a PDF directly to MinIO with the returned URL, then complete the
   upload through the gateway.
4. Show the pending submission becoming complete as the outbox publisher
   delivers an event and the grader consumes it.
5. Fetch the result through the gateway and show the score and feedback.
6. Close by showing the duplicate-event and failure-retry tests.

Use only de-identified sample PDFs. Do not display API keys, JWTs, presigned
URLs, or student-identifying information in a recording.

## Resume bullet drafts

- Built a TypeScript/Fastify multi-service exam grading system with JWT
  authentication, direct S3-compatible uploads, and user-scoped result APIs.
- Implemented a PostgreSQL transactional outbox and Kafka-compatible
  asynchronous grading pipeline with bounded retries and idempotent persistence.
- Integrated Gemini vision grading with PDF page rendering, structured JSON
  output, Zod validation, and local Docker Compose development infrastructure.

Add measured usage, scale, and impact only when supported by real project
measurements.

## Interview prompts and answer points

### Why use a transactional outbox?

The upload service must commit both the submission and the event-to-publish in
the same PostgreSQL transaction. Publishing directly to Kafka before or after
the database commit creates a failure window where the database and broker
disagree. The outbox makes the database commit atomic; a background publisher
can retry unsent rows.

### Why use `FOR UPDATE SKIP LOCKED`?

It lets multiple publisher workers claim different unsent rows without waiting
on rows another worker has locked. Marking the row sent happens after publish,
so a crash can cause redelivery rather than event loss; consumers therefore
must be idempotent.

### How is grading idempotent?

The worker checks and locks the submission before grading, skips completed
submissions, and the `grades.submission_id` uniqueness constraint is the final
database guard against duplicate persisted grades. This handles at-least-once
event delivery without assuming Kafka exactly-once behavior.

### Why use a presigned upload?

The client sends PDF bytes directly to object storage instead of streaming them
through the API. The API retains control of authorization by issuing a short
expiry URL for a specific object key, then verifies the object on completion.
The client-facing presign endpoint must be reachable from the client even when
the storage endpoint used by containers is internal.

### What happens when Gemini returns malformed output or is unavailable?

The response is treated as untrusted data and validated against the grade
schema. Invalid grade JSON gets one corrected retry; request failures flow to
the worker's bounded retry policy and ultimately persist a failure reason.
