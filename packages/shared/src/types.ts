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
