import { evidenceKey, parseEvidenceKey, type EvidenceStore, type StoredEvidence } from "@openfactory/contracts";

/** A faithful fake EvidenceStore kept in memory; URLs point at `<baseUrl>/evidence/<key>`. */
export class InMemoryEvidenceStore implements EvidenceStore {
  readonly name = "memory";
  private readonly files = new Map<string, StoredEvidence>();

  constructor(private readonly baseUrl = "https://factory.example") {}

  async put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; url: string }> {
    const key = evidenceKey(taskId, name);
    this.files.set(key, { bytes: new Uint8Array(bytes), contentType });
    return { key, url: this.url(key) };
  }

  async get(key: string): Promise<StoredEvidence | null> {
    if (parseEvidenceKey(key) === null) return null;
    const f = this.files.get(key);
    return f === undefined ? null : { bytes: new Uint8Array(f.bytes), contentType: f.contentType };
  }

  url(key: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/evidence/${key}`;
  }
}
