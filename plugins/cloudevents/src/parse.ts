/**
 * CloudEvents 1.0 over HTTP: structured mode (application/cloudevents+json), batch mode
 * (application/cloudevents-batch+json) and binary mode (ce-* headers, the body is `data`).
 * Spec: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/bindings/http-protocol-binding.md
 */
import { CloudEvent } from "@openfactory/contracts";

export class CloudEventsError extends Error {
  override readonly name = "CloudEventsError";
}

/** Read every event in one HTTP request. Throws CloudEventsError on anything that isn't a valid CloudEvent. */
export function parseCloudEvents(header: (name: string) => string | undefined | null, body: string): CloudEvent[] {
  const type = (header("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/cloudevents-batch+json")) {
    const arr = json(body);
    if (!Array.isArray(arr)) throw new CloudEventsError("a batch must be a JSON array of events");
    if (arr.length > 500) throw new CloudEventsError("at most 500 events per batch");
    return arr.map(one);
  }
  const ceSpec = header("ce-specversion");
  if (ceSpec) {
    const attr = (n: string) => header(`ce-${n}`) ?? undefined;
    const data = type.includes("json") ? json(body) : body;
    return [
      one({
        specversion: ceSpec,
        id: attr("id"),
        source: attr("source"),
        type: attr("type"),
        ...(attr("time") ? { time: attr("time") } : {}),
        ...(attr("subject") ? { subject: attr("subject") } : {}),
        ...(type ? { datacontenttype: type } : {}),
        data,
      }),
    ];
  }
  // Structured mode, also accepted as plain application/json so curl works.
  const v = json(body);
  return Array.isArray(v) ? v.map(one) : [one(v)];
}

function one(v: unknown): CloudEvent {
  const r = CloudEvent.safeParse(v);
  if (!r.success) throw new CloudEventsError(`not a CloudEvent: ${r.error.issues.map((i) => `${i.path.join(".") || "event"} ${i.message}`).join("; ")}`);
  return r.data;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new CloudEventsError("body is not JSON");
  }
}
