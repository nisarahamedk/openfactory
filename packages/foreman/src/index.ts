/**
 * The foreman: one pi-durable conversation per task (the task Harness's root
 * conversation). It talks to people in the issue while workers work: it
 * acknowledges new tasks and answers questions from the ledger. It runs on its
 * own cheap model, reached through the factory's model proxy.
 *
 * It never changes code and never merges; steering goes through the rules.
 */
import type { Context } from "@earendil-works/chord/context";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { LedgerEvent, TaskRecord, Usage } from "@openfactory/contracts";

export const FOREMAN_PROVIDER = "factory-proxy";

export type ProxyModelConfig = {
  /** OpenAI-compatible base URL of the model proxy, e.g. https://llm.example/v1 (LiteLLM). */
  baseUrl: string;
  apiKey: string;
  modelId: string; // proxy model name, e.g. "claude-haiku"
  /** USD per million tokens, for the ledger's cost column. */
  cost: { input: number; output: number };
};

/** A pi-ai provider that sends the foreman's requests to the model proxy. Keys never leave the control plane. */
export function proxyProvider(cfg: ProxyModelConfig) {
  const model: Model<"openai-completions"> = {
    id: cfg.modelId,
    name: `Foreman (${cfg.modelId})`,
    api: "openai-completions",
    provider: FOREMAN_PROVIDER,
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: cfg.cost.input, output: cfg.cost.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 2_000,
  } as Model<"openai-completions">;
  return createProvider({
    id: FOREMAN_PROVIDER,
    name: "Factory model proxy",
    baseUrl: cfg.baseUrl,
    auth: { apiKey: { name: "Factory model proxy", resolve: async () => ({ auth: { apiKey: cfg.apiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  } as Parameters<typeof createProvider>[0]);
}

export const FOREMAN_INSTRUCTIONS = `You are the foreman of a software factory. One task = one GitHub issue.
A separate coding agent (the worker) does the code in its own sandbox; you never write code.
You talk to the people in the issue: short, plain, friendly, concrete. 1-4 sentences, GitHub markdown.
Answer only from the task facts you are given (status, PR, evidence, cost, recent events). If you don't know, say so.
Never promise a merge: humans merge. To change the work, people comment on the PR; say that if asked.`;

function facts(record: TaskRecord, events: LedgerEvent[]): string {
  const recent = events
    .slice(-12)
    .map((e) => `- ${e.at} ${e.type} ${JSON.stringify(e.data).slice(0, 160)}`)
    .join("\n");
  return [
    `Task ${record.id} "${record.title}" status=${record.status}`,
    `PR: ${record.pr ? `#${record.pr.number} ${record.pr.url} head ${record.pr.headSha ?? "?"}` : "none yet"}`,
    `Evidence: ${record.evidence.map((e) => `${e.title} (${e.commitSha.slice(0, 7)}) ${e.url}`).join("; ") || "none yet"}`,
    `Cost so far: $${record.usage.costUsd.toFixed(2)}; review rounds ${record.people.reviewRounds}`,
    `Environment: ${record.environment?.name ?? "not up"}; factory version ${record.factoryVersion}`,
    `Recent events:\n${recent}`,
  ].join("\n");
}

export function ackFallback(record: TaskRecord): string {
  return `On it. I've started task \`${record.id}\` for this issue: a worker will build it in its own environment, test it, and open a PR with evidence. Ask me here any time for status.`;
}

async function totalCost(h: Harness, ctx: Context): Promise<{ input: number; output: number; cost: number }> {
  const u = (await h.usage(ctx)) as unknown as { models?: Record<string, { input?: number; output?: number; cost?: { total?: number } }> };
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const m of Object.values(u.models ?? {})) {
    input += m.input ?? 0;
    output += m.output ?? 0;
    cost += m.cost?.total ?? 0;
  }
  return { input, output, cost };
}

/**
 * Ask the foreman one thing. `requestId` (e.g. the webhook delivery id) makes a retried delivery
 * return the same answer instead of asking twice.
 */
export async function askForeman(
  h: Harness,
  root: Conversation,
  input: { kind: "ack" | "question"; record: TaskRecord; events: LedgerEvent[]; text: string; requestId: string },
  ctx: Context,
): Promise<{ text: string; usage: Usage }> {
  const before = await totalCost(h, ctx);
  const prompt =
    input.kind === "ack"
      ? `A new task just started from this issue. Acknowledge it in the issue in 2-3 sentences: what will happen next.\n\nIssue: ${input.record.title}\n${input.record.ask.slice(0, 2000)}\n\nFacts:\n${facts(input.record, input.events)}`
      : `Someone wrote in the issue:\n"""${input.text.slice(0, 4000)}"""\n\nReply to them.\n\nFacts:\n${facts(input.record, input.events)}`;
  const submission = await root.submit({ type: "input", content: prompt, requestId: input.requestId }, ctx);
  const settled = await submission.wait(ctx);
  let text = "";
  if (settled.status === "done" && "answer" in settled && settled.answer !== undefined) {
    // biome-ignore lint: the answer is an EntryId; the settled union doesn't narrow it for us.
    const answerId = settled.answer as any;
    const entry = await root.commit((tx) => tx.entry(AssistantEntry, answerId), ctx);
    const message = (entry as { model?: Array<{ content?: Array<{ type: string; text?: string }> }> } | undefined)?.model?.[0];
    text = (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  }
  const after = await totalCost(h, ctx);
  const usage: Usage = {
    inputTokens: Math.max(0, after.input - before.input),
    outputTokens: Math.max(0, after.output - before.output),
    costUsd: Math.max(0, after.cost - before.cost),
  };
  if (!text) text = input.kind === "ack" ? ackFallback(input.record) : "I couldn't work that out just now; I'll keep the task going.";
  return { text, usage };
}
