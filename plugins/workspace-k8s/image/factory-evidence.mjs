#!/usr/bin/env node
/**
 * factory-evidence: the evidence chores every task repeats, done one way so the agent spends its turn on the change.
 *
 *   factory-evidence wait [url] [--timeout 600]      block until the URL answers (default $FACTORY_ENV_URL)
 *   factory-evidence shot <path-or-url> [--title T]  desktop + phone screenshots (light, and dark with --dark),
 *                         [--name n] [--dark]        added to the manifest for HEAD
 *   factory-evidence test <title> -- <command...>    run a test command, keep its output as test-output evidence;
 *                                                    exits with the command's code
 *   factory-evidence list                            what the manifest holds for HEAD
 *
 * Files land in $FACTORY_EVIDENCE_DIR (else $HOME/evidence) and manifest.json there gains one entry per file,
 * with the full HEAD sha and $FACTORY_ENV_NAME, which is what the factory checks before review.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FACTORY_EVIDENCE_DIR || join(process.env.HOME || "/root", "evidence");
const manifestPath = join(dir, "manifest.json");
const envName = process.env.FACTORY_ENV_NAME || "local";
const base = process.env.FACTORY_ENV_URL || "";

const die = (m) => {
  console.error(`factory-evidence: ${m}`);
  process.exit(2);
};
const head = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    die("run me inside the git checkout (couldn't read HEAD)");
  }
};
const manifest = () => (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : []);
const add = (entries) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify([...manifest(), ...entries], null, 2));
  for (const e of entries) console.log(`added ${e.kind}: ${e.title} (${e.file})`);
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";
const flag = (args, name, dflt = null) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (args, name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

async function wait(args) {
  const timeout = Number(flag(args, "--timeout", "600")) * 1000;
  const url = args[0] || base;
  if (!url) die("no URL and no $FACTORY_ENV_URL");
  const until = Date.now() + timeout;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (r.status < 500) return console.log(`up: ${url} answered ${r.status}`);
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  die(`${url} not up after ${timeout / 1000}s (last: ${last}). Check the deploy's logs (kubectl get pods; kubectl logs).`);
}

async function shot(args) {
  const title = flag(args, "--title");
  const name = flag(args, "--name");
  const dark = has(args, "--dark");
  const target = args[0] || "/";
  const url = /^https?:/.test(target) ? target : base ? new URL(target, base).toString() : die("give a full URL or set $FACTORY_ENV_URL");
  const req = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "noop.js"));
  const { chromium, devices } = req("playwright");
  const sha = head();
  const n = name || slug(new URL(url).pathname);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const out = [];
  try {
    const shapes = [
      ["desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
      ["phone", { ...devices["iPhone 13"] }],
    ];
    for (const scheme of dark ? ["light", "dark"] : ["light"])
      for (const [label, opts] of shapes) {
        const ctx = await browser.newContext({ ...opts, colorScheme: scheme, ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch((e) => die(`couldn't open ${url}: ${e.message}`));
        if (res && res.status() >= 400) die(`${url} answered ${res.status()}; fix that before taking evidence`);
        const file = `${n}-${label}${dark ? `-${scheme}` : ""}-${sha.slice(0, 7)}.png`;
        await page.screenshot({ path: join(dir, file), fullPage: true });
        await ctx.close();
        out.push({ kind: "screenshot", title: `${title || new URL(url).pathname} (${label}${dark ? `, ${scheme}` : ""})`, file, commitSha: sha, environment: envName });
      }
  } finally {
    await browser.close();
  }
  add(out);
}

async function test(args) {
  const sep = args.indexOf("--");
  if (sep < 1 || sep === args.length - 1) die('usage: factory-evidence test "<title>" -- <command...>');
  const title = args.slice(0, sep).join(" ");
  const cmd = args.slice(sep + 1);
  const sha = head();
  mkdirSync(dir, { recursive: true });
  const file = `test-${slug(title)}-${sha.slice(0, 7)}.txt`;
  const path = join(dir, file);
  writeFileSync(path, `$ ${cmd.join(" ")}\n\n`);
  const code = await new Promise((done) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const tee = (d, to) => {
      to.write(d);
      appendFileSync(path, d);
    };
    p.stdout.on("data", (d) => tee(d, process.stdout));
    p.stderr.on("data", (d) => tee(d, process.stderr));
    p.on("close", (c) => done(c ?? 1));
    p.on("error", (e) => {
      appendFileSync(path, `\n${e.message}\n`);
      done(127);
    });
  });
  appendFileSync(path, `\nexit code ${code}\n`);
  add([{ kind: "test-output", title: `${title}: ${code === 0 ? "passed" : `failed (exit ${code})`}`, file, commitSha: sha, environment: envName }]);
  process.exit(code);
}

function list() {
  const sha = head();
  const mine = manifest().filter((e) => e.commitSha === sha);
  if (!mine.length) return console.log(`no evidence for HEAD ${sha.slice(0, 7)} yet`);
  for (const e of mine) console.log(`${e.kind}\t${e.title}\t${e.file ?? ""}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = { wait, shot, test, list }[cmd];
if (!run) die("usage: factory-evidence wait|shot|test|list (see the top of this file)");
await run(rest);
