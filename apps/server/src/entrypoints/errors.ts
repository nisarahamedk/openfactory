/**
 * Error translation for HTTP (the-stack docs/errors.md). Every core error code gets its status here, explicitly:
 * a new code fails type-checking until it's placed. Bodies are { code, message, details, requestId, retryable }.
 */
import { details, retryable, type ErrorCode, type FactoryError } from "@openfactory/core";

/** HTTP status by what the caller can do about it. */
export function statusOf(code: ErrorCode): 400 | 403 | 404 | 409 | 422 | 502 {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "TASK_NOT_FOUND":
    case "FACTORY_NOT_FOUND":
    case "VIEW_NOT_FOUND":
    case "PERSON_NOT_FOUND":
    case "BENCHMARK_TASK_NOT_FOUND":
    case "RUN_NOT_FOUND":
    case "BENCHMARKS_NOT_SET_UP":
      return 404;
    case "TASK_NOT_REVIEWABLE":
    case "TASK_BUSY":
    case "TASK_NOT_MERGED":
      return 409;
    case "NO_HIDDEN_CHECK":
      return 422;
    // The factory's own dependency failed; the same call may work in a moment.
    case "CODE_HOST_UNAVAILABLE":
      return 502;
    // The repo isn't one the factory works in: the caller names another, or an admin connects it.
    case "REPO_NOT_CONNECTED":
      return 400;
    default: {
      const never: never = code;
      return never;
    }
  }
}

/** The public body of an error. */
export type PublicError = { code: string; message: string; details: Record<string, unknown> | null; requestId: string; retryable: boolean };

/** A core error as its public body. */
export function publicError(e: FactoryError, requestId: string): PublicError {
  return { code: e.code, message: e.message, details: details(e), requestId, retryable: retryable(e) };
}
