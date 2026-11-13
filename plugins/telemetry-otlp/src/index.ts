import { type LedgerEvent, type MetricsSink, type TaskId, type TaskRecord } from "@openfactory/contracts";
import { buildTaskSpans, type OtlpSpan, type TraceOptions } from "./trace.js";

export { buildTaskSpans, traceIdFor, type OtlpSpan } from "./trace.js";
export { redact } from "./redact.js";

export interface OtlpExporterConfig {
  /** OTLP/HTTP base URL, e.g. http://otel-collector:4318 (spans go to <endpoint>/v1/traces). */
  endpoint: string;
  /** Extra headers, e.g. an API key for a vendor's OTLP intake. */
  headers: Record<string, string>;
  serviceName: string;
  /** Reads a task's events; the factory passes its ledger. */
  events: (taskId: TaskId) => Promise<LedgerEvent[]>;
  trace?: Partial<TraceOptions>;
  fetch?: typeof fetch;
}

/**
 * Exports each task as an OpenTelemetry trace over OTLP/HTTP JSON: "export everything,
 * read back nothing". Speaks the protocol directly (no OTel SDK), so the only version
 * that matters is the OTLP protocol (1.x, stable), and any collector or vendor intake
 * (Datadog, Honeycomb, Grafana Tempo...) can receive it.
 *
 * It is a MetricsSink: the factory calls writeTasks after scoring. Finished spans are
 * sent once per process; IDs are deterministic, so a restart re-sends identical spans.
 */
export class OtlpTaskExporter implements MetricsSink {
  readonly name = "otlp";
  private readonly sent = new Set<string>();
  private readonly opts: TraceOptions;

  constructor(private readonly cfg: OtlpExporterConfig) {
    this.opts = { includeTitles: true, includeText: false, extraRedactions: [], ...cfg.trace };
  }

  async writeTasks(records: TaskRecord[]): Promise<void> {
    const fresh: OtlpSpan[] = [];
    for (const r of records) {
      for (const s of buildTaskSpans(r, await this.cfg.events(r.id), this.opts)) if (!this.sent.has(s.spanId)) fresh.push(s);
    }
    if (fresh.length === 0) return;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.cfg.serviceName } }] },
          scopeSpans: [{ scope: { name: "openfactory", version: "0.0.1" }, spans: fresh }],
        },
      ],
    };
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.endpoint.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.cfg.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OTLP export failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await res.body?.cancel();
    for (const s of fresh) this.sent.add(s.spanId);
  }
}

/** `k1=v1,k2=v2`, the OTEL_EXPORTER_OTLP_HEADERS format (values URL-encoded). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(",")
      .map((p) => p.split("="))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0]!.trim() !== "")
      .map(([k, v]) => [k.trim(), decodeURIComponent(v.trim())]),
  );
}

/**
 * Standard OTel env vars: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_SERVICE_NAME. Returns null when no endpoint is set (telemetry off).
 */
export function otlpFromEnv(env: Record<string, string | undefined>, events: OtlpExporterConfig["events"]): OtlpTaskExporter | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  return new OtlpTaskExporter({
    endpoint,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME ?? "openfactory",
    events,
    trace: { includeText: env.OTLP_INCLUDE_TEXT === "true" },
  });
}

