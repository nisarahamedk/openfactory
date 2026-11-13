import { describeEvidenceStoreConformance } from "@openfactory/conformance";
import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { S3EvidenceStore, type S3EvidenceConfig } from "./index.js";

/**
 * Runs against a real S3-API server when S3_TEST_ENDPOINT is set, e.g. MinIO or RustFS:
 *   docker run -p 19000:9000 -e RUSTFS_ACCESS_KEY=... -e RUSTFS_SECRET_KEY=... rustfs/rustfs
 *   S3_TEST_ENDPOINT=http://localhost:19000 S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... pnpm test
 * Each run makes a fresh bucket.
 */
const endpoint = process.env.S3_TEST_ENDPOINT ?? "";
const live = endpoint !== "";

function config(bucket: string, over: Partial<S3EvidenceConfig> = {}): S3EvidenceConfig {
  return {
    endpoint,
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    bucket,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? "",
    prefix: "evidence/",
    publicBaseUrl: null,
    serverUrl: "https://factory.example",
    ...over,
  };
}

async function makeBucket(): Promise<string> {
  const bucket = `of-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const c = config(bucket);
  const aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: "s3" });
  const res = await aws.fetch(`${endpoint.replace(/\/$/, "")}/${bucket}`, { method: "PUT" });
  if (!res.ok) throw new Error(`create bucket failed: ${res.status} ${await res.text()}`);
  return bucket;
}

if (live) {
  describeEvidenceStoreConformance(`S3EvidenceStore @ ${endpoint}`, async () => {
    const bucket = await makeBucket();
    return { subject: new S3EvidenceStore(config(bucket)), cleanup: async () => {} };
  });
}

describe("S3EvidenceStore URLs and signing (no server needed)", () => {
  it("links through the factory server unless a public base URL is set", () => {
    expect(new S3EvidenceStore(config("b", { endpoint: "http://x" })).url("task_a/s.png")).toBe("https://factory.example/evidence/task_a/s.png");
    expect(new S3EvidenceStore(config("b", { endpoint: "http://x", publicBaseUrl: "https://cdn.example/" })).url("task_a/s.png")).toBe(
      "https://cdn.example/evidence/task_a/s.png",
    );
  });

  it("signs a path-style PUT with the content type, and reads 404 as missing", async () => {
    const seen: Request[] = [];
    const fake: typeof fetch = async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      seen.push(req);
      return new Response(null, { status: req.method === "GET" ? 404 : 200 });
    };
    const s = new S3EvidenceStore(config("bucket1", { endpoint: "http://s3.test", accessKeyId: "AK", secretAccessKey: "SK", fetch: fake }));
    await s.put("task_a", "shot.png", new Uint8Array([1, 2]), "image/png");
    expect(await s.get("task_a/shot.png")).toBeNull();
    expect(seen[0]?.url).toBe("http://s3.test/bucket1/evidence/task_a/shot.png");
    expect(seen[0]?.headers.get("content-type")).toBe("image/png");
    expect(seen[0]?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
    expect(await s.get("../x")).toBeNull();
    expect(seen).toHaveLength(2);
  });
});
