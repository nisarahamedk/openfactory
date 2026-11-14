/**
 * Acme, the simulated org: one shared repo (FirstWord) seen by three teams, the six personas, the tools
 * work comes from, and a first week of asks. Every login is made up and never @-mentioned on GitHub
 * (the server runs with MENTIONS=off).
 */
import type { Persona } from "@openfactory/contracts";

export const REPO = "nisarahamedk/firstword";
export const SLACK = "https://acme-sim.slack.com";
export const TEAMS_SRC = "https://teams.acme-sim.example/tenant/acme";
export const JIRA = "https://acme-sim.atlassian.net";
export const CD = "https://github.com/nisarahamedk/firstword/actions";
export const ROOTLY = "https://rootly.com/acme-sim";
export const DATADOG = "https://app.datadoghq.com/acme-sim";

export type SimPerson = { login: string; name: string; persona: Persona; slack: string; msteams: string; jira: string; teams: string[] };

export const PEOPLE: SimPerson[] = [
  { login: "acme-pat", name: "Pat Rivera", persona: "platform_director", slack: "U0PAT", msteams: "aad-pat", jira: "jira-pat", teams: ["platform"] },
  { login: "acme-sam", name: "Sam Okafor", persona: "factory_engineer", slack: "U0SAM", msteams: "aad-sam", jira: "jira-sam", teams: ["platform"] },
  { login: "acme-ravi", name: "Ravi Menon", persona: "engineer", slack: "U0RAVI", msteams: "aad-ravi", jira: "jira-ravi", teams: ["platform"] },
  { login: "acme-lena", name: "Lena Vogel", persona: "em", slack: "U0LENA", msteams: "aad-lena", jira: "jira-lena", teams: ["web"] },
  { login: "acme-maya", name: "Maya Chen", persona: "engineer", slack: "U0MAYA", msteams: "aad-maya", jira: "jira-maya", teams: ["web"] },
  { login: "acme-jon", name: "Jon Bell", persona: "engineer", slack: "U0JON", msteams: "aad-jon", jira: "jira-jon", teams: ["web"] },
  { login: "acme-omar", name: "Omar Haddad", persona: "em", slack: "U0OMAR", msteams: "aad-omar", jira: "jira-omar", teams: ["payments"] },
  { login: "acme-priya", name: "Priya Nair", persona: "engineer", slack: "U0PRIYA", msteams: "aad-priya", jira: "jira-priya", teams: ["payments"] },
  { login: "acme-dee", name: "Dee Brooks", persona: "director", slack: "U0DEE", msteams: "aad-dee", jira: "jira-dee", teams: [] },
  { login: "acme-vic", name: "Vic Tan", persona: "vp", slack: "U0VIC", msteams: "aad-vic", jira: "jira-vic", teams: [] },
];

export const email = (p: SimPerson) => `${p.login.replace(/^acme-/, "")}@acme-sim.example`;

export const FACTORIES = [
  {
    slug: "web",
    description: "Screens and marketing pages: every change ships a Playwright check and screenshots on desktop and phone.",
    scorers: ["e2e-added"],
    benchmarks: [],
    world: null,
    mergeRisk: { high: ["src/routes/_auth/**", "src/server/**"], low: ["marketing/**", "**/*.md"] },
  },
  {
    slug: "payments",
    description: "Plans and billing: billing paths always need a human reviewer, and the 30-day world must keep money conserved.",
    scorers: ["ledger-balances"],
    benchmarks: [],
    world: "firstword-30d",
    mergeRisk: { high: ["src/routes/_app/account.plan.tsx", "packages/core/**/billing*", "drizzle/**"], low: ["**/*.md"] },
  },
  {
    slug: "platform",
    description: "Tooling, tests and docs: low-risk changes merge on green CI with one reviewer.",
    scorers: [],
    benchmarks: [],
    world: null,
    mergeRisk: { high: ["infra/**", "alchemy.run.ts", "wrangler.jsonc"], low: ["docs/**", "tests/**", "**/*.md"] },
  },
];

export const TEAMS = [
  { slug: "web", name: "Web", description: "Marketing site and app screens", factory: "web", members: ["acme-lena", "acme-maya", "acme-jon"], scope: { paths: ["src/routes/**", "src/components/**", "marketing/**"], labels: ["ui", "copy"] } },
  { slug: "payments", name: "Payments", description: "Plans, billing and the account plan page", factory: "payments", members: ["acme-omar", "acme-priya"], scope: { paths: ["src/routes/_app/account.plan.tsx", "packages/core/**"], labels: ["billing"] } },
  { slug: "platform", name: "Platform", description: "Tooling, tests, docs and the factory itself", factory: "platform", members: ["acme-sam", "acme-ravi", "acme-pat"], scope: { paths: ["scripts/**", "tests/**", "docs/**", "infra/**"], labels: ["infra", "test", "docs"] } },
];

/** Channels and projects → teams, so an ask lands in the right team. */
export const SOURCES: Array<{ id: string; kind: "slack" | "msteams" | "jira" | "cdevents" | "rootly" | "datadog"; name: string; ceSource: string; uses: Array<"asks" | "deploys" | "outcomes">; routes: Record<string, string> }> = [
  { id: "slack", kind: "slack", name: "Acme Slack", ceSource: SLACK, uses: ["asks"], routes: { C0WEB: "web", C0PAY: "payments", C0PLAT: "platform" } },
  { id: "msteams", kind: "msteams", name: "Acme Microsoft Teams", ceSource: TEAMS_SRC, uses: ["asks"], routes: { "19:payments": "payments" } },
  { id: "jira", kind: "jira", name: "Acme Jira", ceSource: JIRA, uses: ["asks"], routes: { WEB: "web", PAY: "payments", PLAT: "platform" } },
  { id: "deploys", kind: "cdevents", name: "Deploy pipeline (CDEvents)", ceSource: CD, uses: ["deploys", "outcomes"], routes: {} },
  { id: "rootly", kind: "rootly", name: "Rootly", ceSource: ROOTLY, uses: ["outcomes"], routes: {} },
  { id: "datadog", kind: "datadog", name: "Datadog monitors", ceSource: DATADOG, uses: ["outcomes"], routes: {} },
];

export type Ask = { key: string; via: "slack" | "msteams" | "jira"; by: string; place: string; text: string; labels?: string[] };

/** Week one: small asks, the kind a team hands the factory first. */
export const WEEK1: Ask[] = [
  { key: "web-privacy-date", via: "slack", by: "acme-maya", place: "C0WEB", text: "Privacy page: show a 'Last updated' date under the title, taken from one constant in the page file. Small UI change, needs a screenshot.", labels: ["ui", "small"] },
  { key: "web-footer-year", via: "jira", by: "acme-jon", place: "WEB", text: "Marketing footer: the copyright year should come from the current date instead of being typed in.", labels: ["ui", "small"] },
  { key: "pay-plan-renewal", via: "msteams", by: "acme-priya", place: "19:payments", text: "Account plan page: under the plan name, show when the plan renews (or ends, if cancelled) as a full date like '14 December 2026'.", labels: ["billing", "ui"] },
  { key: "pay-plan-copy", via: "jira", by: "acme-omar", place: "PAY", text: "Account plan page: the button that opens billing should say 'Manage billing' everywhere (it says different things in two places).", labels: ["billing", "copy", "small"] },
  { key: "plat-format-test", via: "slack", by: "acme-ravi", place: "C0PLAT", text: "Add unit tests for src/lib/format.ts covering durations under a minute, exactly one minute, and over an hour.", labels: ["test", "small"] },
  { key: "plat-agents-one-test", via: "jira", by: "acme-sam", place: "PLAT", text: "Docs: add a short 'Run one test file' section to AGENTS.md with the exact command, and check it works.", labels: ["docs", "small"] },
];
