type LogFields = Readonly<Record<string, string | number | boolean | null>>;
type LogLevel = "debug" | "info" | "warn" | "error";

function writeLog(level: LogLevel, message: string, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields
  };

  const output = `${JSON.stringify(entry)}\n`;
  if (level === "error") {
    process.stderr.write(output);
    return;
  }

  process.stdout.write(output);
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => writeLog("debug", message, fields),
  info: (message: string, fields?: LogFields): void => writeLog("info", message, fields),
  warn: (message: string, fields?: LogFields): void => writeLog("warn", message, fields),
  error: (message: string, fields?: LogFields): void => writeLog("error", message, fields)
};
