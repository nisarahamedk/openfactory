/** The pod a workspace asks for, checked against a stub Kubernetes API (no cluster needed). */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { provider } from "../src/index.js";

interface Stub {
  url: string;
  objects: Map<string, Record<string, any>>;
  close(): Promise<void>;
}

/** Keeps what is POSTed; a pod reads back as Ready. */
async function stubApi(): Promise<Stub> {
  const objects = new Map<string, Record<string, any>>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const notFound = () => send(404, { kind: "Status", code: 404, reason: "NotFound" });
      if (req.method === "POST") {
        const obj = JSON.parse(body);
        objects.set(`${path}/${obj.metadata.name}`, obj);
        return send(201, obj);
      }
      const obj = objects.get(path);
      if (req.method === "DELETE") {
        objects.delete(path);
        return obj === undefined ? notFound() : send(200, obj);
      }
      if (obj === undefined) return notFound();
      if (path.includes("/pods/")) return send(200, { ...obj, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } });
      return send(200, obj);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function kubeconfigFor(url: string): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "stub", cluster: { server: url, "insecure-skip-tls-verify": true } }],
    users: [{ name: "stub", user: { token: "stub" } }],
    contexts: [{ name: "stub", context: { cluster: "stub", user: "stub" } }],
    "current-context": "stub",
  });
}

describe("workspace pod", () => {
  let stub: Stub | null = null;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  const podFor = async (options: Record<string, unknown>, env: Record<string, string> = {}) => {
    stub = await stubApi();
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const kubeconfig = join(mkdtempSync(join(tmpdir(), "of-kc-")), "config");
    writeFileSync(kubeconfig, kubeconfigFor(stub.url));
    const workspaces = await provider.provides.workspace!({
      options: { kubeconfig, namespace: "ws", image: "worker:1", ...options },
      env,
      log: () => undefined,
    });
    await workspaces.create({ taskId: "task_abc", repo: { host: "github", owner: "acme", name: "app" }, branch: "factory/x", image: null });
    const pod = stub.objects.get("/api/v1/namespaces/ws/pods/ws-task-abc");
    expect(pod).toBeDefined();
    return pod!;
  };
  const envOf = (container: any) => Object.fromEntries((container.env as { name: string; value?: string }[]).map((e) => [e.name, e.value]));

  it("labels the pod with its task and sets no proxy by default", async () => {
    const pod = await podFor({});
    expect(pod.metadata.labels["openfactory.dev/task"]).toBe("task_abc");
    expect(envOf(pod.spec.containers[0]).HTTPS_PROXY).toBeUndefined();
  });

  it("sends both containers through the egress proxy and passes the allowlist on", async () => {
    const pod = await podFor({ egress: { proxy: "http://egress.factory.svc:3128", allow: ["github.com", "registry.npmjs.org"] } });
    for (const c of [pod.spec.initContainers[0], pod.spec.containers[0]]) {
      const env = envOf(c);
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(env[k]).toBe("http://egress.factory.svc:3128");
      expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
    }
    expect(pod.metadata.annotations["openfactory.dev/egress-allow"]).toBe("github.com,registry.npmjs.org");
    expect(envOf(pod.spec.containers[0]).FACTORY_EGRESS_ALLOW).toBe("github.com,registry.npmjs.org");
  });

  it("takes the proxy from env when factory.yaml has none, and rejects unknown egress options", async () => {
    const pod = await podFor({}, { WORKSPACE_EGRESS_PROXY: "http://p:1", WORKSPACE_NO_PROXY: "localhost,.svc" });
    expect(envOf(pod.spec.containers[0]).https_proxy).toBe("http://p:1");
    expect(envOf(pod.spec.containers[0]).no_proxy).toBe("localhost,.svc");
    await expect(podFor({ egress: { proxi: "x" } })).rejects.toThrow(/egress.proxi/);
  });
});
