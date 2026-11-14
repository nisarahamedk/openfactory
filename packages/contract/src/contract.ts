/**
 * The factory's API contract: every operation's path, input and output, and nothing else.
 *
 * This is the only backend package clients import (the-stack §3.2). Who may call an operation,
 * its risk tier and which surfaces expose it live in the capability registry in @openfactory/core,
 * keyed by the same names (the-stack P18). REST (/v1) and the MCP tools are both derived from the
 * pair, and a test fails when they drift.
 *
 * Changes are additive: new fields and operations only, no renames or removals.
 */
import { oc } from "@orpc/contract";
import { z } from "zod";
import { BenchmarkTask, InboundEvent, LedgerEvent, OrgFactory, OrgState, OrgTeam, ConnectedSource, Person, RolloutState, SavedView, Signal, TaskId, TaskRecord, TaskStatus, Team } from "@openfactory/contracts";
import { BenchRun } from "@openfactory/bench";
import {
  ApproveTask,
  AuditEntry,
  CancelTask,
  ConnectOrgRepo,
  ConnectOrgSource,
  EgressReport,
  FactoryInfo,
  FactoryView,
  HealthReport,
  InvitePerson,
  NewTaskRequest,
  PostMessage,
  RetryTask,
  SaveOrgFactory,
  SaveOrgTeam,
  SaveView,
  SetOrg,
  SetRollout,
  StartBenchRun,
} from "./schemas.js";

const taskId = z.object({ id: TaskId.meta({ description: "Task id, e.g. task_k3x9a1 (from listTasks)" }) });
const slug = z.string().min(1).max(100);
const one = <K extends string, T extends z.ZodType>(key: K, schema: T) => z.object({ [key]: schema } as { [P in K]: T });

/** Every operation of the factory API, keyed by operation id. */
export const contract = {
  // Tasks
  listTasks: oc
    .route({ method: "GET", path: "/tasks", summary: "List tasks, newest first", tags: ["tasks"] })
    .input(z.object({ status: TaskStatus.optional(), limit: z.coerce.number().int().min(1).max(500).optional().meta({ example: 50 }) }))
    .output(one("tasks", z.array(TaskRecord))),
  getTask: oc
    .route({ method: "GET", path: "/tasks/{id}", summary: "One task's ledger record (status, PR, cost, scores, evidence, outcomes)", tags: ["tasks"] })
    .input(taskId)
    .output(one("task", TaskRecord)),
  listTaskEvents: oc
    .route({ method: "GET", path: "/tasks/{id}/events", summary: "The task's append-only event log, oldest first", tags: ["tasks"] })
    .input(taskId)
    .output(one("events", z.array(LedgerEvent))),
  createTask: oc
    .route({ method: "POST", path: "/tasks", successStatus: 202, summary: "Ask for a task: opens an issue with the factory label in the repo (or the person's team repo) and starts it", tags: ["tasks"] })
    .input(NewTaskRequest)
    .output(z.object({ issueUrl: z.string(), repo: z.string(), issueNumber: z.number().int() })),
  cancelTask: oc
    .route({ method: "POST", path: "/tasks/{id}/cancel", summary: "Stop a task: abort its running turn, put its environment to sleep, mark it failed (stage \"cancelled\"). A later comment resumes it.", tags: ["tasks"] })
    .input(CancelTask.extend(taskId.shape))
    .output(one("task", TaskRecord)),
  retryTask: oc
    .route({ method: "POST", path: "/tasks/{id}/retry", summary: "Try a failed or stopped task again: from intake when it has no PR, else as a review round that carries on", tags: ["tasks"] })
    .input(RetryTask.extend(taskId.shape))
    .output(one("task", TaskRecord)),
  approveTask: oc
    .route({ method: "POST", path: "/tasks/{id}/approve", summary: "Approve the task's PR as a person. Recorded on the task and posted on the PR; it never starts a review round, and merging stays a person's call", tags: ["tasks"] })
    .input(ApproveTask.extend(taskId.shape))
    .output(one("task", TaskRecord)),
  postTaskMessage: oc
    .route({ method: "POST", path: "/tasks/{id}/messages", summary: "Write to the task as a person: posted where the task lives (PR or issue) and handed to its agent like a comment", tags: ["tasks"] })
    .input(PostMessage.extend(taskId.shape))
    .output(z.object({ task: TaskRecord, url: z.string().nullable() })),

  // Factory
  getHealth: oc
    .route({ method: "GET", path: "/health", summary: "Start-up checks: code host, repos, model gateway and routed models, each with a fix when it fails", tags: ["factory"] })
    .output(one("health", HealthReport)),
  getFactory: oc
    .route({ method: "GET", path: "/factory", summary: "This factory: version, providers (no secrets), agent and foreman models, rules and prompts", tags: ["factory"] })
    .output(one("factory", FactoryInfo)),
  listFactories: oc
    .route({ method: "GET", path: "/factories", summary: "The org default factory and every team factory built on it, with each one's rollout", tags: ["factory"] })
    .output(z.object({ factories: z.array(FactoryView), rollouts: z.array(RolloutState) })),
  getRollout: oc
    .route({ method: "GET", path: "/rollout/{factory}", summary: "A factory's live version, candidate and the candidate's share of new tasks, with history", tags: ["factory"] })
    .input(z.object({ factory: slug }))
    .output(z.object({ rollout: RolloutState.nullable(), history: z.array(RolloutState) })),
  setRollout: oc
    .route({ method: "POST", path: "/rollout/{factory}", summary: "Change which version new tasks run on: send a share to a candidate, promote, or roll back", tags: ["factory"] })
    .input(SetRollout.extend({ factory: slug }))
    .output(one("rollout", RolloutState)),
  listTeams: oc
    .route({ method: "GET", path: "/teams", summary: "Teams and their people and repos, from the org's directory (GitHub teams, SSO groups or factory.yaml) and the app", tags: ["org"] })
    .output(one("teams", z.array(Team))),

  // Machine inputs
  postSignal: oc
    .route({ method: "POST", path: "/signals", successStatus: 202, summary: "Inject a signal (issue labelled, comment, merge...) as if a signal source had sent it", tags: ["inputs"] })
    .input(Signal)
    .output(z.object({ result: z.unknown() })),
  postEgress: oc
    .route({ method: "POST", path: "/egress", successStatus: 202, summary: "Egress proxy collector: what each task's sandbox reached, aggregated per host and window (denied hosts included)", tags: ["inputs"] })
    .input(EgressReport)
    .output(z.object({ recorded: z.number().int() })),

  // Benchmarks
  addToBenchmark: oc
    .route({ method: "POST", path: "/tasks/{id}/benchmark", successStatus: 201, summary: "Add a merged task to the benchmark suite (Harbor task folder)", tags: ["benchmarks"] })
    .input(taskId)
    .output(z.object({ task: BenchmarkTask, files: z.array(z.string()) })),
  listBenchmarkTasks: oc
    .route({ method: "GET", path: "/bench/tasks", summary: "The benchmark suite", tags: ["benchmarks"] })
    .output(one("tasks", z.array(BenchmarkTask))),
  startBenchRun: oc
    .route({ method: "POST", path: "/bench/runs", successStatus: 202, summary: "Start a paired A-vs-B replay run in the background", tags: ["benchmarks"] })
    .input(StartBenchRun)
    .output(one("run", BenchRun)),
  listBenchRuns: oc
    .route({ method: "GET", path: "/bench/runs", summary: "A-vs-B runs, newest first", tags: ["benchmarks"] })
    .output(one("runs", z.array(BenchRun))),
  getBenchRun: oc
    .route({ method: "GET", path: "/bench/runs/{id}", summary: "One run with its results and report", tags: ["benchmarks"] })
    .input(z.object({ id: z.string().regex(/^run_[a-z0-9]+$/).meta({ description: "Run id, e.g. run_m3k2x9ab (from listBenchRuns)" }) }))
    .output(one("run", BenchRun)),

  // Saved views
  listViews: oc
    .route({ method: "GET", path: "/views", summary: "Saved views a person may see: their own, their teams' and the org's", tags: ["views"] })
    .input(z.object({ viewer: z.string().min(1).max(100).optional().meta({ description: "Deprecated: defaults to the signed-in person", example: "dana" }) }))
    .output(one("views", z.array(SavedView))),
  getView: oc
    .route({ method: "GET", path: "/views/{id}", summary: "One saved view (anyone with the id may open it)", tags: ["views"] })
    .input(z.object({ id: z.string().min(1).max(100) }))
    .output(one("view", SavedView)),
  saveView: oc
    .route({ method: "POST", path: "/views", summary: "Save a view: a name plus the app path holding its scope, filters, measure and grouping", tags: ["views"] })
    .input(SaveView)
    .output(one("view", SavedView)),
  deleteView: oc
    .route({ method: "POST", path: "/views/{id}/delete", summary: "Delete a saved view (its owner only)", tags: ["views"] })
    .input(z.object({ id: z.string().min(1).max(100), by: z.string().min(1).max(100).optional() }))
    .output(z.object({ deleted: z.boolean() })),

  // Org setup
  getOrg: oc
    .route({ method: "GET", path: "/org", summary: "The org as set up in the app: name, repos, people with personas, teams, team factories, connected tools and setup progress", tags: ["org"] })
    .output(one("org", OrgState)),
  setOrg: oc.route({ method: "POST", path: "/org", summary: "Name the org (the first setup step); the person becomes its first admin", tags: ["org"] }).input(SetOrg).output(one("org", OrgState)),
  connectRepo: oc.route({ method: "POST", path: "/org/repos", summary: "Connect a repo the factory may open PRs in", tags: ["org"] }).input(ConnectOrgRepo).output(one("org", OrgState)),
  invitePerson: oc
    .route({ method: "POST", path: "/org/people", summary: "Invite a person (or change one) with a persona, role and their ids in Slack, Teams and Jira", tags: ["org"] })
    .input(InvitePerson)
    .output(one("person", Person)),
  joinOrg: oc
    .route({ method: "POST", path: "/org/people/{login}/join", summary: "Mark an invited person as joined (they signed in)", tags: ["org"] })
    .input(z.object({ login: Person.shape.login }))
    .output(one("person", Person)),
  saveTeam: oc
    .route({ method: "POST", path: "/org/teams", summary: "Create or change a team: members, repos, the part of a shared repo it owns, and its factory", tags: ["org"] })
    .input(SaveOrgTeam)
    .output(one("team", OrgTeam)),
  saveFactory: oc
    .route({ method: "POST", path: "/org/factories", summary: "Create or change a team factory on top of the org default", tags: ["org"] })
    .input(SaveOrgFactory)
    .output(one("factory", OrgFactory)),
  connectSource: oc
    .route({ method: "POST", path: "/org/sources", summary: "Connect a tool whose CloudEvents start work or report outcomes (Slack, Microsoft Teams, Jira, Datadog, Rootly, PagerDuty, any CDEvents producer)", tags: ["org"] })
    .input(ConnectOrgSource)
    .output(one("source", ConnectedSource)),
  listEvents: oc
    .route({ method: "GET", path: "/events", summary: "Inbound events, newest first, each with what the factory did with it", tags: ["org"] })
    .input(z.object({ source: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }))
    .output(one("events", z.array(InboundEvent))),

  // Audit
  listAudit: oc
    .route({ method: "GET", path: "/audit", summary: "Who changed what: every state-changing call through the API, MCP, the app and connected tools, newest first", tags: ["audit"] })
    .input(z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), target: z.string().max(200).optional() }))
    .output(one("entries", z.array(AuditEntry))),
};

/** The contract's operation names. */
export type OperationName = keyof typeof contract;
