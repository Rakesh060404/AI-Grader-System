ALTER TABLE outbox
    ADD COLUMN claimed_until timestamptz;

CREATE INDEX outbox_claimable_idx
    ON outbox (claimed_until, created_at, id)
    WHERE sent_at IS NULL;
