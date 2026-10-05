import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDatabasePool } from "../../../packages/shared/dist/index.js";
import { processSubmission } from "../dist/processSubmission.js";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must be configured for grader integration tests");
const pool = createDatabasePool(databaseUrl);

async function createSubmissionFixture() {
  const userId = randomUUID();
  const uploadIntentId = randomUUID();
  const submissionId = randomUUID();
  const objectKey = `grader-tests/${submissionId}.pdf`;

  await pool.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [userId, `${userId}@grader.test`, "not-used"]
  );
  await pool.query(
    `INSERT INTO upload_intents
      (id, user_id, object_key, content_type, max_size_bytes, expires_at)
     VALUES ($1, $2, $3, 'application/pdf', 1024, now() + interval '1 hour')`,
    [uploadIntentId, userId, objectKey]
  );
  await pool.query(
    `INSERT INTO submissions (id, user_id, upload_intent_id, object_key)
     VALUES ($1, $2, $3, $4)`,
    [submissionId, userId, uploadIntentId, objectKey]
  );

  return {
    submissionId,
    event: { eventId: randomUUID(), submissionId, schemaVersion: 1 },
    async cleanup() {
      await pool.query("DELETE FROM grades WHERE submission_id = $1", [submissionId]);
      await pool.query("DELETE FROM outbox WHERE submission_id = $1", [submissionId]);
      await pool.query("DELETE FROM submissions WHERE id = $1", [submissionId]);
      await pool.query("DELETE FROM upload_intents WHERE id = $1", [uploadIntentId]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
  };
}

function createS3Stub(pdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n", "ascii")) {
  return {
    send: async () => ({
      ContentLength: pdfBytes.byteLength,
      Body: {
        transformToByteArray: async () => pdfBytes
      }
    })
  };
}

test("duplicate submission events persist one grade", async () => {
  const fixture = await createSubmissionFixture();
  let gradeCalls = 0;

  try {
    const dependencies = {
      s3: createS3Stub(),
      bucket: "unused-test-bucket",
      model: "test-model",
      rubric: "test rubric",
      grade: async (path, rubric) => {
        gradeCalls += 1;
        assert.equal(rubric, "test rubric");
        assert.match(await readFile(path, "ascii"), /^%PDF-/);
        return { score: 8, feedback: ["Good work"] };
      }
    };

    await processSubmission(pool, fixture.event, dependencies);
    await processSubmission(pool, fixture.event, dependencies);

    const result = await pool.query(
      `SELECT s.status, s.grading_attempts, count(g.id)::text AS grade_count
       FROM submissions s
       LEFT JOIN grades g ON g.submission_id = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [fixture.submissionId]
    );

    assert.deepEqual(result.rows[0], {
      status: "done",
      grading_attempts: 1,
      grade_count: "1"
    });
    assert.equal(gradeCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("grading failure is retried a bounded number of times and recorded", async () => {
  const fixture = await createSubmissionFixture();
  let gradeCalls = 0;

  try {
    await processSubmission(pool, fixture.event, {
      s3: createS3Stub(),
      bucket: "unused-test-bucket",
      model: "test-model",
      rubric: "test rubric",
      grade: async () => {
        gradeCalls += 1;
        throw new Error("simulated provider failure");
      }
    });

    const result = await pool.query(
      "SELECT status, grading_attempts, failure_reason FROM submissions WHERE id = $1",
      [fixture.submissionId]
    );
    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].grading_attempts, 3);
    assert.match(result.rows[0].failure_reason, /simulated provider failure/);
    assert.equal(gradeCalls, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid PDF bytes end in failed status with an explanatory reason", async () => {
  const fixture = await createSubmissionFixture();

  try {
    await processSubmission(pool, fixture.event, {
      s3: createS3Stub(Buffer.from("not a PDF", "ascii")),
      bucket: "unused-test-bucket",
      model: "test-model",
      rubric: "test rubric",
      grade: async () => {
        assert.fail("The grader must not receive invalid PDF bytes");
      }
    });

    const result = await pool.query(
      "SELECT status, grading_attempts, failure_reason FROM submissions WHERE id = $1",
      [fixture.submissionId]
    );
    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].grading_attempts, 3);
    assert.match(result.rows[0].failure_reason, /not a valid PDF/);
  } finally {
    await fixture.cleanup();
  }
});

test.after(async () => {
  await pool.end();
});
