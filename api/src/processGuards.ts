// Process-level safety nets for #2044 — last-resort guards, not the
// primary defense. The primary defense is per-route: asyncHandler.ts
// forwards a rejected async route handler's error to next(err), and
// errorMiddleware.ts turns that into a clean 500. A throwing route should
// never actually reach these listeners in normal operation.
//
// These exist for what route-level handling can't cover: a rejected
// promise started outside any request/response cycle (a fire-and-forget
// call with no .catch(), a background job), or a future route added
// without the asyncHandler wrapper.
//
// unhandledRejection and uncaughtException are deliberately handled
// differently:
//
// - unhandledRejection: a promise rejected somewhere and nothing awaited
//   or .catch()'d it. The process itself is not in a corrupted state
//   just because one promise rejected — log it and keep serving.
// - uncaughtException: a synchronous throw escaped every try/catch and
//   every Express handler entirely. Node's own docs are explicit that
//   the process is now in an undefined state and must not keep handling
//   new work. Log for the record, then exit deliberately (not
//   process.exit(0) — this is a real crash, and letting Docker's restart
//   policy bring up a fresh, known-good process is the correct outcome,
//   not silently surviving in a state that might be half-broken).
//
// The logging bodies are exported separately from the process.on() wiring
// so tests can exercise the logic directly without touching the real
// process object (triggering an actual uncaughtException/unhandledRejection
// in a test run would take the test runner down with it).

export function logUnhandledRejection(reason: unknown): void {
  console.error('[api] Unhandled promise rejection:', reason);
}

export function logUncaughtExceptionAndExit(
  err: unknown,
  exit: (code: number) => void = process.exit.bind(process),
): void {
  console.error('[api] Uncaught exception, exiting:', err);
  exit(1);
}

export function installProcessGuards(): void {
  process.on('unhandledRejection', logUnhandledRejection);
  process.on('uncaughtException', (err) => logUncaughtExceptionAndExit(err));
}
