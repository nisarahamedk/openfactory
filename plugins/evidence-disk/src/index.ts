import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceKey, parseEvidenceKey, type EvidenceStore, type StoredEvidence } from "@openfactory/contracts";

/** Where files live on disk and the server URL that serves them (`<publicUrl>/evidence/<key>`). */
export interface DiskEvidenceConfig {
  dir: string;
  publicUrl: string;
}

/**
 * EvidenceStore on a local directory (a PVC on k8s): `<dir>/<taskId>/<name>` plus a
 * `<name>.type` sidecar holding the content type. Writes are atomic (temp file + rename).
 * The factory server serves files back through its `/evidence/<taskId>/<name>` route.
 */
export class DiskEvidenceStore implements EvidenceStore {
  readonly name = "disk";

  constructor(private readonly cfg: DiskEvidenceConfig) {}

  async put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; url: string }> {
    const key = evidenceKey(taskId, name);
    if (name.endsWith(".type") || name.endsWith(".tmp")) throw new Error(`reserved evidence name: ${name}`);
    const folder = join(this.cfg.dir, taskId);
    await mkdir(folder, { recursive: true });
    await atomicWrite(join(folder, `${name}.type`), contentType);
    await atomicWrite(join(folder, name), bytes);
    return { key, url: this.url(key) };
  }

  async get(key: string): Promise<StoredEvidence | null> {
    const k = parseEvidenceKey(key);
    if (k === null || k.name.endsWith(".type") || k.name.endsWith(".tmp")) return null;
    try {
      const bytes = await readFile(join(this.cfg.dir, k.taskId, k.name));
      const contentType = await readFile(join(this.cfg.dir, k.taskId, `${k.name}.type`), "utf8").catch(() => "application/octet-stream");
      return { bytes: new Uint8Array(bytes), contentType };
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  url(key: string): string {
    return `${this.cfg.publicUrl.replace(/\/$/, "")}/evidence/${key}`;
  }
}

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
