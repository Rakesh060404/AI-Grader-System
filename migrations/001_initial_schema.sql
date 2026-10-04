CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE grades (
    id            uuid PRIMARY KEY,
    submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
    score         numeric NOT NULL CHECK (score >= 0),
    feedback      jsonb NOT NULL,
    model         text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
    id            uuid PRIMARY KEY,
    submission_id uuid NOT NULL REFERENCES submissions(id),
    event_type    text NOT NULL,
    payload       jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX outbox_unsent_idx
    ON outbox (created_at, id)
    WHERE sent_at IS NULL;
