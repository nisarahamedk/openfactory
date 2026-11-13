import { AwsClient } from "aws4fetch";
import { evidenceKey, parseEvidenceKey, type EvidenceStore, type StoredEvidence } from "@openfactory/contracts";

/**
 * Any S3-API object store: AWS S3, Cloudflare R2, MinIO, RustFS, Ceph...
 * Objects live at `<prefix><taskId>/<name>` in one bucket, addressed path-style
 * (`<endpoint>/<bucket>/<object>`), which all of the above accept.
 */
export interface S3EvidenceConfig {
  /** e.g. https://s3.eu-central-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000 */
  endpoint: string;
  /** e.g. "eu-central-1"; R2 uses "auto". */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Object key prefix, e.g. "evidence/". Empty for none. */
  prefix: string;
  /**
   * Where reviewers open files. A public bucket or CDN base (`<publicBaseUrl>/<prefix><key>`),
   * or null to link through the factory server's `/evidence/<key>` route, which calls get().
   */
  publicBaseUrl: string | null;
  /** The factory server's public URL, used when publicBaseUrl is null. */
  serverUrl: string;
  fetch?: typeof fetch;
}

/** EvidenceStore over the S3 API, signed with SigV4 (aws4fetch, no AWS SDK). */
export class S3EvidenceStore implements EvidenceStore {
  readonly name = "s3";
  private readonly aws: AwsClient;

  constructor(private readonly cfg: S3EvidenceConfig) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "s3" });
  }

  private objectUrl(key: string): string {
    const path = `${this.cfg.prefix}${key}`.split("/").map(encodeURIComponent).join("/");
    return `${this.cfg.endpoint.replace(/\/$/, "")}/${encodeURIComponent(this.cfg.bucket)}/${path}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const req = await this.aws.sign(url, init);
    return (this.cfg.fetch ?? fetch)(req);
  }

  async put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; url: string }> {
    const key = evidenceKey(taskId, name);
    const res = await this.send(this.objectUrl(key), { method: "PUT", body: new Uint8Array(bytes), headers: { "content-type": contentType, "content-length": String(bytes.byteLength) } });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await res.body?.cancel();
    return { key, url: this.url(key) };
  }

  async get(key: string): Promise<StoredEvidence | null> {
    if (parseEvidenceKey(key) === null) return null;
    const res = await this.send(this.objectUrl(key), { method: "GET" });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new Error(`S3 GET ${key} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  url(key: string): string {
    if (this.cfg.publicBaseUrl !== null) return `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${this.cfg.prefix}${key}`;
    return `${this.cfg.serverUrl.replace(/\/$/, "")}/evidence/${key}`;
  }
}

import { defineProvider } from "@openfactory/contracts";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * factory.yaml:
 *   evidence: { s3: { endpoint: https://..., bucket: evidence, region: auto, prefix: "evidence/", publicBaseUrl: null } }
 * Credentials from env: S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (names overridable with accessKeyEnv / secretKeyEnv).
 */
export const provider = defineProvider({
  name: "s3",
  provides: {
    evidence: (ctx) => {
      const o = ctx.options;
      const endpoint = str(o.endpoint) ?? str(ctx.env.S3_ENDPOINT);
      const bucket = str(o.bucket) ?? str(ctx.env.S3_BUCKET);
      const accessKeyId = str(ctx.env[str(o.accessKeyEnv) ?? "S3_ACCESS_KEY_ID"]);
      const secretAccessKey = str(ctx.env[str(o.secretKeyEnv) ?? "S3_SECRET_ACCESS_KEY"]);
      const serverUrl = str(ctx.env.PUBLIC_URL);
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !serverUrl)
        throw new Error("s3 evidence provider: endpoint, bucket, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and PUBLIC_URL are required");
      return new S3EvidenceStore({
        endpoint,
        bucket,
        region: str(o.region) ?? str(ctx.env.S3_REGION) ?? "auto",
        accessKeyId,
        secretAccessKey,
        prefix: str(o.prefix) ?? "evidence/",
        publicBaseUrl: str(o.publicBaseUrl),
        serverUrl,
      });
    },
  },
});
