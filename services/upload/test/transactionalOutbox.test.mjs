import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDatabasePool } from "../../../packages/shared/dist/index.js";
import { completeSubmission } from "../dist/completeSubmission.js";

test("submission and outbox are rolled back together after a failure", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be configured for this integration test");

  const pool = createDatabasePool(databaseUrl);
  const userId = randomUUID();
  const uploadIntentId = randomUUID();

  try {
    await pool.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
      [userId, `${userId}@rollback.test`, "not-used"]
    );
    await pool.query(
      `INSERT INTO upload_intents
        (id, user_id, object_key, content_type, max_size_bytes, expires_at)
       VALUES ($1, $2, $3, 'application/pdf', 1024, now() + interval '1 hour')`,
      [uploadIntentId, userId, `rollback/${uploadIntentId}.pdf`]
    );

    await assert.rejects(
      completeSubmission({
        pool,
        uploadIntentId,
        userId,
        afterOutboxInsert: async () => {
          throw new Error("forced failure after submission and outbox inserts");
        }
      }),
      /forced failure after submission and outbox inserts/
    );

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::text FROM submissions WHERE upload_intent_id = $1) AS submissions,
         (SELECT count(*)::text FROM outbox
          WHERE submission_id IN (
            SELECT id FROM submissions WHERE upload_intent_id = $1
          )) AS outbox`,
      [uploadIntentId]
    );

    assert.deepEqual(counts.rows[0], { submissions: "0", outbox: "0" });
  } finally {
    await pool.query("DELETE FROM upload_intents WHERE id = $1", [uploadIntentId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
  }
});
