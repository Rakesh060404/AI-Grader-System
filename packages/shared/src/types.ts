import { z } from "zod";

export type SubmissionStatus = "pending" | "grading" | "done" | "failed";

export interface GradeResult {
  score: number;
  feedback: string[];
}

export interface SubmissionCompletedEvent {
  eventId: string;
  submissionId: string;
  schemaVersion: 1;
}

export const submissionCompletedEventSchema = z.object({
  eventId: z.string().uuid(),
  submissionId: z.string().uuid(),
  schemaVersion: z.literal(1)
}).strict();
