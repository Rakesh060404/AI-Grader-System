import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import {
  type GradeResult,
  type SubmissionCompletedEvent,
  logger
} from "@ai-grader/shared";
import { gradePdf } from "./gradePdf.js";

const MAX_GRADING_ATTEMPTS = 3;

interface GradingDependencies {
  s3: S3Client;
  bucket: string;
  model: string;
  rubric: string;
  grade?: (path: string, rubric: string) => Promise<GradeResult>;
}

interface SubmissionForGrading {
  id: string;
  object_key: string;
  status: "pending" | "grading" | "done" | "failed";
  grading_attempts: number;
  has_grade: boolean;
}

async function startGrading(
  pool: Pool,
  submissionId: string
): Promise<{ objectKey: string; attempt: number } | undefined> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<SubmissionForGrading>(
      `SELECT s.id, s.object_key, s.status, s.grading_attempts,
              EXISTS (
                SELECT 1 FROM grades g WHERE g.submission_id = s.id
              ) AS has_grade
       FROM submissions s
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [submissionId]
    );
    const submission = result.rows[0];
    if (!submission) {
      await client.query("COMMIT");
      logger.error("Received an event for a missing submission", { submissionId });
      return undefined;
    }
    if (submission.status === "done" || submission.has_grade) {
      await client.query(
        `UPDATE submissions
         SET status = 'done', failure_reason = NULL, updated_at = now()
         WHERE id = $1`,
        [submissionId]
      );
      await client.query("COMMIT");
      logger.info("Skipping an already graded submission", { submissionId });
      return undefined;
    }
    if (submission.grading_attempts >= MAX_GRADING_ATTEMPTS) {
      await client.query(
        `UPDATE submissions
         SET status = 'failed',
             failure_reason = COALESCE(failure_reason, 'Maximum grading attempts reached'),
             updated_at = now()
         WHERE id = $1`,
        [submissionId]
      );
      await client.query("COMMIT");
      logger.error("Submission has exhausted its grading attempts", { submissionId });
      return undefined;
    }

    const attempt = submission.grading_attempts + 1;
    await client.query(
      `UPDATE submissions
       SET status = 'grading',
           grading_attempts = $2,
           failure_reason = NULL,
           updated_at = now()
       WHERE id = $1`,
      [submissionId, attempt]
    );
    await client.query("COMMIT");
    return { objectKey: submission.object_key, attempt };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Could not roll back the grading claim transaction"
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function persistGrade(
  pool: Pool,
  submissionId: string,
  result: GradeResult,
  model: string
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO grades (id, submission_id, score, feedback, model)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (submission_id) DO NOTHING`,
      [randomUUID(), submissionId, result.score, JSON.stringify(result.feedback), model]
    );
    await client.query(
      `UPDATE submissions
       SET status = 'done', failure_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [submissionId]
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Grade persistence failed and its transaction could not be rolled back"
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function persistFailure(
  pool: Pool,
  submissionId: string,
  attempt: number,
  error: unknown
): Promise<void> {
  const reason = (error instanceof Error ? error.message : "Unknown grading error").slice(0, 2000);
  const status = attempt >= MAX_GRADING_ATTEMPTS ? "failed" : "pending";
  await pool.query(
    `UPDATE submissions
     SET status = $2, failure_reason = $3, updated_at = now()
     WHERE id = $1`,
    [submissionId, status, reason]
  );
  logger.error("Submission grading attempt failed", {
    submissionId,
    attempt,
    maxAttempts: MAX_GRADING_ATTEMPTS,
    terminal: status === "failed",
    error: reason
  });
}

async function withTemporaryPdf<T>(
  s3: S3Client,
  bucket: string,
  objectKey: string,
  operation: (path: string) => Promise<T>
): Promise<T> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey })
  );
  if (!response.Body) {
    throw new Error("Object storage returned an empty PDF body");
  }
  if (
    typeof response.ContentLength !== "number" ||
    response.ContentLength <= 0 ||
    response.ContentLength > 10 * 1024 * 1024
  ) {
    throw new Error("Stored PDF is empty or exceeds the configured upload size limit");
  }

  const directory = await mkdtemp(join(tmpdir(), "ai-grader-"));
  const path = join(directory, "submission.pdf");
  try {
    const bytes = await response.Body.transformToByteArray();
    if (
      bytes.byteLength < 5 ||
      bytes.byteLength > 10 * 1024 * 1024 ||
      Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
    ) {
      throw new Error("Stored object is not a valid PDF within the upload size limit");
    }
    await writeFile(path, bytes);
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function processSubmission(
  pool: Pool,
  event: SubmissionCompletedEvent,
  dependencies: GradingDependencies
): Promise<void> {
  for (;;) {
    const claim = await startGrading(pool, event.submissionId);
    if (!claim) {
      return;
    }

    try {
      const grade = dependencies.grade ?? gradePdf;
      const result = await withTemporaryPdf(
        dependencies.s3,
        dependencies.bucket,
        claim.objectKey,
        (path) => grade(path, dependencies.rubric)
      );
      await persistGrade(pool, event.submissionId, result, dependencies.model);
      logger.info("Submission graded", {
        submissionId: event.submissionId,
        attempt: claim.attempt
      });
      return;
    } catch (error) {
      await persistFailure(pool, event.submissionId, claim.attempt, error);
      if (claim.attempt >= MAX_GRADING_ATTEMPTS) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (claim.attempt - 1)));
    }
  }
}
