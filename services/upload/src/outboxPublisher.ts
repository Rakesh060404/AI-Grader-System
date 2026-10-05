import type { Pool } from "pg";
import type { Producer } from "kafkajs";
import {
  submissionCompletedEventSchema,
  TOPICS
} from "@ai-grader/shared";
import { logger } from "@ai-grader/shared";

const CLAIM_BATCH_SIZE = 10;
const CLAIM_LEASE_MS = 45_000;
const POLL_INTERVAL_MS = 500;

interface ClaimedOutboxRow {
  id: string;
  payload: unknown;
}

async function claimOutboxRows(pool: Pool): Promise<ClaimedOutboxRow[]> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const rows = await client.query<ClaimedOutboxRow>(
      `SELECT id, payload
       FROM outbox
       WHERE sent_at IS NULL
         AND (claimed_until IS NULL OR claimed_until < now())
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [CLAIM_BATCH_SIZE]
    );
    if (rows.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const ids = rows.rows.map((row) => row.id);
    await client.query(
      `UPDATE outbox
       SET claimed_until = now() + ($2 * interval '1 millisecond'),
           attempts = attempts + 1
       WHERE id = ANY($1::uuid[])`,
      [ids, CLAIM_LEASE_MS]
    );
    await client.query("COMMIT");
    return rows.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Outbox claim failed and the transaction could not be rolled back"
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function releaseClaims(pool: Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await pool.query(
    `UPDATE outbox
     SET claimed_until = NULL
     WHERE id = ANY($1::uuid[]) AND sent_at IS NULL`,
    [ids]
  );
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runOutboxPublisher(
  pool: Pool,
  producer: Producer,
  signal: AbortSignal
): Promise<void> {
  let connected = false;

  while (!signal.aborted) {
    let claimedRows: ClaimedOutboxRow[] = [];

    try {
      if (!connected) {
        await producer.connect();
        connected = true;
        logger.info("Outbox publisher connected to Kafka");
      }

      claimedRows = await claimOutboxRows(pool);
      if (claimedRows.length > 0) {
        const messages = claimedRows.map((row) => {
          const parsed = submissionCompletedEventSchema.safeParse(row.payload);
          if (!parsed.success) {
            throw new Error(`Outbox row ${row.id} has an invalid event payload`);
          }
          return {
            key: parsed.data.submissionId,
            value: JSON.stringify(parsed.data),
            headers: { eventId: parsed.data.eventId }
          };
        });

        await producer.send({
          topic: TOPICS.submissionCompleted,
          messages,
          acks: -1,
          timeout: 10_000
        });
        const ids = claimedRows.map((row) => row.id);
        const result = await pool.query(
          `UPDATE outbox
           SET sent_at = now(), claimed_until = NULL
           WHERE id = ANY($1::uuid[]) AND sent_at IS NULL`,
          [ids]
        );

        if (result.rowCount !== ids.length) {
          throw new Error("Not all published outbox rows could be marked as sent");
        }
        logger.info("Published outbox events", { count: ids.length });
      } else {
        await waitForNextPoll(signal);
      }
    } catch (error) {
      const ids = claimedRows.map((row) => row.id);
      try {
        await releaseClaims(pool, ids);
      } catch (releaseError) {
        logger.error("Failed to release outbox event claims", {
          error: releaseError instanceof Error ? releaseError.message : "Unknown error"
        });
      }

      logger.error("Outbox publisher iteration failed; events remain retryable", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
      if (connected) {
        connected = false;
        try {
          await producer.disconnect();
        } catch (disconnectError) {
          logger.error("Failed to disconnect the Kafka producer after an error", {
            error: disconnectError instanceof Error
              ? disconnectError.message
              : "Unknown error"
          });
        }
      }
      await waitForNextPoll(signal);
    }
  }

  if (connected) {
    await producer.disconnect();
  }
}
