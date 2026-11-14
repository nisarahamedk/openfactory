/**
 * Expected failures of factory operations, as typed values (the-stack docs/errors.md).
 *
 * Each variant has a literal `code`, a message that says what failed and what to do next, and the safe ids
 * that locate it. Entrypoints translate every code explicitly (an exhaustive switch), so adding a code fails
 * type-checking until each surface decides its status, copy and retry advice.
 */
export type FactoryError =
  | { code: "FORBIDDEN"; message: string; operation: string; reason: "role" | "agent_risk" | "not_owner" }
  | { code: "INVALID_REQUEST"; message: string; fields: { path: string; message: string }[] }
  | { code: "TASK_NOT_FOUND"; message: string; taskId: string }
  | { code: "TASK_NOT_REVIEWABLE"; message: string; taskId: string; status: string }
  | { code: "TASK_BUSY"; message: string; taskId: string }
  | { code: "TASK_NOT_MERGED"; message: string; taskId: string }
  | { code: "NO_HIDDEN_CHECK"; message: string; taskId: string }
  | { code: "FACTORY_NOT_FOUND"; message: string; factory: string }
  | { code: "VIEW_NOT_FOUND"; message: string; viewId: string }
  | { code: "PERSON_NOT_FOUND"; message: string; login: string }
  | { code: "REPO_NOT_CONNECTED"; message: string; repo: string | null }
  | { code: "BENCHMARKS_NOT_SET_UP"; message: string }
  | { code: "BENCHMARK_TASK_NOT_FOUND"; message: string; benchmarkTaskId: string }
  | { code: "RUN_NOT_FOUND"; message: string; runId: string }
  | { code: "CODE_HOST_UNAVAILABLE"; message: string; repo: string }
  | { code: "DEFINITIONS_NOT_IN_GIT"; message: string };

/** Every error code. */
export type ErrorCode = FactoryError["code"];

/** Thrown by use cases for an expected failure; entrypoints catch it and translate `error`. */
export class Failure extends Error {
  constructor(readonly error: FactoryError) {
    super(error.message);
    this.name = "Failure";
  }
}

/** Throw an expected failure. */
export function fail(error: FactoryError): never {
  throw new Failure(error);
}

/** Whether the same call may succeed if repeated unchanged. Truthful per code: a busy task, or a code host that failed to answer. */
export function retryable(e: FactoryError): boolean {
  switch (e.code) {
    case "TASK_BUSY":
    case "CODE_HOST_UNAVAILABLE":
      return true;
    case "FORBIDDEN":
    case "INVALID_REQUEST":
    case "TASK_NOT_FOUND":
    case "TASK_NOT_REVIEWABLE":
    case "TASK_NOT_MERGED":
    case "NO_HIDDEN_CHECK":
    case "FACTORY_NOT_FOUND":
    case "VIEW_NOT_FOUND":
    case "PERSON_NOT_FOUND":
    case "REPO_NOT_CONNECTED":
    case "BENCHMARKS_NOT_SET_UP":
    case "BENCHMARK_TASK_NOT_FOUND":
    case "RUN_NOT_FOUND":
    case "DEFINITIONS_NOT_IN_GIT":
      return false;
    default: {
      const never: never = e;
      return never;
    }
  }
}

/** The error's safe details: everything except code and message. */
export function details(e: FactoryError): Record<string, unknown> {
  const { code: _code, message: _message, ...rest } = e;
  return rest;
}

export const errors = {
  notInGit: (): FactoryError => ({ code: "DEFINITIONS_NOT_IN_GIT", message: "Factory definitions aren't kept in git on this factory. An admin sets FACTORY_DEFINITIONS_REPO to turn that on." }),
  taskNotFound: (taskId: string): FactoryError => ({ code: "TASK_NOT_FOUND", taskId, message: `Task ${taskId} was not found. Check the id (listTasks shows every task) and try again.` }),
  invalid: (message: string, fields: { path: string; message: string }[] = []): FactoryError => ({ code: "INVALID_REQUEST", message, fields }),
  factoryNotFound: (factory: string): FactoryError => ({ code: "FACTORY_NOT_FOUND", factory, message: `There is no factory "${factory}". listFactories shows the org default and every team factory.` }),
  viewNotFound: (viewId: string): FactoryError => ({ code: "VIEW_NOT_FOUND", viewId, message: `Saved view ${viewId} was not found. It may have been deleted by its owner.` }),
  personNotFound: (login: string): FactoryError => ({ code: "PERSON_NOT_FOUND", login, message: `Nobody with the login ${login} has been invited. Invite them first (invitePerson).` }),
};
