import { z } from "zod";

const databaseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    "Must be a PostgreSQL connection URL"
  );

export const environmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  KAFKA_BROKERS: z
    .string()
    .transform((value) => value.split(",").map((broker) => broker.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1)),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  JWT_SECRET: z.string().min(32),
  OPENROUTER_API_KEY: z.string().min(1)
});

const gradingEnvironmentSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().trim().min(1)
});

export type AppConfig = z.infer<typeof environmentSchema>;
export type GradingConfig = z.infer<typeof gradingEnvironmentSchema>;

export function loadDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const result = databaseUrlSchema.safeParse(environment.DATABASE_URL);

  if (!result.success) {
    throw new Error(`Invalid DATABASE_URL: ${result.error.issues[0]?.message ?? "invalid value"}`);
  }

  return result.data;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}

export function loadGradingConfig(environment: NodeJS.ProcessEnv = process.env): GradingConfig {
  const result = gradingEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid grading configuration: ${details}`);
  }

  return result.data;
}
