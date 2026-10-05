import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SubmissionCompletedEvent } from "@ai-grader/shared";

export class UploadCompletionConflict extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "UploadCompletionConflict";
  }
}

export interface CompleteSubmissionInput {
  pool: Pool;
  uploadIntentId: string;
  userId: string;
  afterOutboxInsert?: () => Promise<void>;
}

export interface CompletedSubmission {
  submissionId: string;
  eventId: string;
}

export async function completeSubmission({
  pool,
  uploadIntentId,
  userId,
  afterOutboxInsert
}: CompleteSubmissionInput): Promise<CompletedSubmission> {
  const client = await pool.connect();
  const submissionId = randomUUID();
  const eventId = randomUUID();

  try {
    await client.query("BEGIN");

    const intentResult = await client.query<{
      id: string;
      expires_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id, expires_at, completed_at
       FROM upload_intents
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [uploadIntentId, userId]
    );
    const intent = intentResult.rows[0];

    if (!intent) {
      throw new UploadCompletionConflict(404, "Upload intent not found");
    }
    if (intent.completed_at) {
      throw new UploadCompletionConflict(409, "Upload intent has already been completed");
    }
    if (new Date(intent.expires_at).getTime() <= Date.now()) {
      throw new UploadCompletionConflict(410, "Upload intent has expired");
    }

    await client.query(
      `INSERT INTO submissions (id, user_id, upload_intent_id, object_key)
       SELECT $1, user_id, id, object_key
       FROM upload_intents
       WHERE id = $2 AND user_id = $3`,
      [submissionId, uploadIntentId, userId]
    );

    const event: SubmissionCompletedEvent = {
      eventId,
      submissionId,
      schemaVersion: 1
    };
    await client.query(
      `INSERT INTO outbox (id, submission_id, event_type, payload)
       VALUES ($1, $2, 'submission.completed', $3::jsonb)`,
      [eventId, submissionId, JSON.stringify(event)]
    );

    if (afterOutboxInsert) {
      await afterOutboxInsert();
    }

    const updateResult = await client.query(
      `UPDATE upload_intents
       SET completed_at = now()
       WHERE id = $1 AND user_id = $2 AND completed_at IS NULL`,
      [uploadIntentId, userId]
    );
    if (updateResult.rowCount !== 1) {
      throw new UploadCompletionConflict(409, "Upload intent is no longer available");
    }

    await client.query("COMMIT");
    return { submissionId, eventId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Upload completion failed and its transaction could not be rolled back"
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
