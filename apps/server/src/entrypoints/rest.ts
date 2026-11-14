/**
 * REST: the contract served at /v1 by oRPC's OpenAPI handler. Each handler only calls the core; who may call,
 * the risk check and the audit row happen there, the same for every surface.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, onError, ORPCError } from "@orpc/server";
import { ApiError, contract, type OperationName } from "@openfactory/contract";
import { Failure, type Actor, type Core, type InputOf } from "@openfactory/core";
import { publicError, statusOf, type PublicError } from "./errors.js";

type Ctx = { actor: Actor };

const scope = new AsyncLocalStorage<{ requestId: string }>();

/** oRPC's own failures (no route input matched, unreadable body) in our error shape. */
function encode(e: ORPCError<string, unknown>): PublicError {
  const requestId = scope.getStore()?.requestId ?? "unknown";
  const data = e.data;
  const ours = ApiError.safeParse(data);
  if (ours.success) return ours.data;
  if (e.code === "BAD_REQUEST") {
    const issues = data !== null && typeof data === "object" && "issues" in data && Array.isArray(data.issues) ? data.issues : [];
    const fields = issues.map((i: { path?: Array<string | number | { key: string | number }>; message?: string }) => ({
      path: (i.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))).join("."),
      message: i.message ?? "invalid",
    }));
    const first = fields[0];
    return {
      code: "INVALID_REQUEST",
      message: `The request doesn't match the API${first ? `: ${first.path || "body"} ${first.message}` : ""}. Fix it and send it again; /v1/openapi.json has every operation's shape.`,
      details: { fields },
      requestId,
      retryable: false,
    };
  }
  return { code: "INTERNAL", message: `The factory failed to handle this request. Quote request ${requestId} when you report it.`, details: null, requestId, retryable: false };
}

/** Handlers for every contract operation; a missing one fails type-checking. */
function router(core: Core) {
  const os = implement(contract).$context<Ctx>();
  const call =
    <K extends OperationName>(name: K) =>
    ({ input, context }: { input: InputOf<K>; context: Ctx }) =>
      core.execute(name, context.actor, input);
  return os.router({
    listTasks: os.listTasks.handler(call("listTasks")),
    getTask: os.getTask.handler(call("getTask")),
    listTaskEvents: os.listTaskEvents.handler(call("listTaskEvents")),
    createTask: os.createTask.handler(call("createTask")),
    cancelTask: os.cancelTask.handler(call("cancelTask")),
    retryTask: os.retryTask.handler(call("retryTask")),
    approveTask: os.approveTask.handler(call("approveTask")),
    postTaskMessage: os.postTaskMessage.handler(call("postTaskMessage")),
    getHealth: os.getHealth.handler(call("getHealth")),
    getFactory: os.getFactory.handler(call("getFactory")),
    listFactories: os.listFactories.handler(call("listFactories")),
    getRollout: os.getRollout.handler(call("getRollout")),
    setRollout: os.setRollout.handler(call("setRollout")),
    listTeams: os.listTeams.handler(call("listTeams")),
    postSignal: os.postSignal.handler(call("postSignal")),
    postEgress: os.postEgress.handler(call("postEgress")),
    addToBenchmark: os.addToBenchmark.handler(call("addToBenchmark")),
    listBenchmarkTasks: os.listBenchmarkTasks.handler(call("listBenchmarkTasks")),
    startBenchRun: os.startBenchRun.handler(call("startBenchRun")),
    listBenchRuns: os.listBenchRuns.handler(call("listBenchRuns")),
    getBenchRun: os.getBenchRun.handler(call("getBenchRun")),
    listViews: os.listViews.handler(call("listViews")),
    getView: os.getView.handler(call("getView")),
    saveView: os.saveView.handler(call("saveView")),
    deleteView: os.deleteView.handler(call("deleteView")),
    getOrg: os.getOrg.handler(call("getOrg")),
    setOrg: os.setOrg.handler(call("setOrg")),
    connectRepo: os.connectRepo.handler(call("connectRepo")),
    invitePerson: os.invitePerson.handler(call("invitePerson")),
    joinOrg: os.joinOrg.handler(call("joinOrg")),
    saveTeam: os.saveTeam.handler(call("saveTeam")),
    saveFactory: os.saveFactory.handler(call("saveFactory")),
    connectSource: os.connectSource.handler(call("connectSource")),
    listEvents: os.listEvents.handler(call("listEvents")),
    listAudit: os.listAudit.handler(call("listAudit")),
  });
}

/** Serve /v1 for one request as `actor`; `null` when no operation matches the path. */
export function createRestHandler(core: Core, log: (m: string, f?: object) => void): (req: Request, actor: Actor) => Promise<Response | null> {
  const handler = new OpenAPIHandler(router(core), {
    customErrorResponseBodyEncoder: encode,
    clientInterceptors: [
      async ({ next, context }) => {
        try {
          return await next();
        } catch (e) {
          // Expected failures, translated explicitly by code; anything else is a defect for the top-level handler.
          if (e instanceof Failure) throw new ORPCError(e.error.code, { defined: true, status: statusOf(e.error.code), message: e.error.message, data: publicError(e.error, context.actor.requestId) });
          throw e;
        }
      },
    ],
    interceptors: [
      onError((e) => {
        if (e instanceof ORPCError && e.code !== "INTERNAL_SERVER_ERROR") return;
        log("defect", { requestId: scope.getStore()?.requestId, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      }),
    ],
  });
  return (req, actor) =>
    scope.run({ requestId: actor.requestId }, async () => {
      const { matched, response } = await handler.handle(req, { prefix: "/v1", context: { actor } });
      return matched ? response : null;
    });
}
