function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info(scope: string, msg: string): void {
    console.log(`${ts()} [${scope}] ${msg}`);
  },
  warn(scope: string, msg: string): void {
    console.warn(`${ts()} [${scope}] WARN ${msg}`);
  },
  error(scope: string, msg: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : err ? ` — ${String(err)}` : "";
    console.error(`${ts()} [${scope}] ERROR ${msg}${detail}`);
  },
};
