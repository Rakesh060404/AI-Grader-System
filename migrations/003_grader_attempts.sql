ALTER TABLE submissions
    ADD COLUMN grading_attempts integer NOT NULL DEFAULT 0
        CHECK (grading_attempts >= 0);
