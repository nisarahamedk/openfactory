import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceStore } from "@openfactory/task-job";

const SAFE = /^[A-Za-z0-9._-]{1,200}$/;

/** Evidence copied out of sandboxes, on disk under DATA_DIR, served at /evidence/:taskId/:file. */
export function fileEvidenceStore(dir: string, publicUrl: string): EvidenceStore & { read(taskId: string, name: string): Promise<{ bytes: Buffer; type: string } | null> } {
  return {
    async put(taskId, name, bytes, contentType) {
      if (!SAFE.test(taskId) || !SAFE.test(name)) throw new Error("bad evidence name");
      await mkdir(join(dir, taskId), { recursive: true });
      await writeFile(join(dir, taskId, name), bytes);
      await writeFile(join(dir, taskId, `${name}.type`), contentType);
      return { url: `${publicUrl.replace(/\/$/, "")}/evidence/${taskId}/${encodeURIComponent(name)}` };
    },
    async read(taskId, name) {
      if (!SAFE.test(taskId) || !SAFE.test(name) || name.endsWith(".type")) return null;
      try {
        const bytes = await readFile(join(dir, taskId, name));
        const type = await readFile(join(dir, taskId, `${name}.type`), "utf8").catch(() => "application/octet-stream");
        return { bytes, type };
      } catch {
        return null;
      }
    },
  };
}
