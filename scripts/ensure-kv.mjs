#!/usr/bin/env node
//
// Ensures KV namespaces declared in wrangler.jsonc exist in the current
// Cloudflare account, creating any that are missing and patching the
// real namespace IDs into wrangler.jsonc.
//
// Why this exists:
//   Wrangler requires a concrete `id` for every kv_namespaces entry at
//   deploy time. The Deploy to Cloudflare button auto-provisions
//   namespaces on first deploy but doesn't write the IDs back to the
//   forked repo. The next deploy then tries to re-create namespaces
//   with the same title and fails with "A KV namespace with the title
//   ... already exists". This script fixes both problems by managing
//   the lifecycle ourselves: list, create-if-missing, patch.
//
// How it works:
//   1. Parse wrangler.jsonc → read `name` and `kv_namespaces[*].binding`.
//   2. `wrangler kv namespace list` (JSON output) → find an existing
//      namespace whose title matches `<worker_name>-<binding>` exactly,
//      with a case-insensitive fuzzy fallback for resources that may
//      have been created with a slightly different convention.
//   3. If absent, `wrangler kv namespace create <worker_name>-<binding>`
//      and re-list to capture the new ID.
//   4. Regex-swap the `"id": ""` placeholder for each binding in
//      wrangler.jsonc with the real ID.
//
// Idempotent: if every binding already has a matching real ID, the
// file is left untouched.
//
// Prerequisites: wrangler must be authenticated (either `wrangler login`
// or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). The deploy itself
// needs the same credentials, so this isn't an extra burden.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const wranglerPath = resolve(repoRoot, "wrangler.jsonc");

// Locate the wrangler binary explicitly. `npx --no-install wrangler`
// is unreliable in CI when the script's cwd is /tmp (e.g. Workers
// Builds with `bun install`): npx walks up from cwd looking for
// node_modules, finds none, and exits before we can reach the
// project's local install. Pointing at node_modules/.bin/wrangler
// directly sidesteps the resolution entirely.
function resolveWranglerBin() {
  const local = resolve(repoRoot, "node_modules", ".bin", "wrangler");
  if (existsSync(local)) return local;
  // Fall back to PATH lookup. If wrangler is globally installed (rare
  // but possible on a maintainer's machine), this still works. If it
  // isn't, the spawn will fail and runWrangler() prints a hint.
  return "wrangler";
}
const wranglerBin = resolveWranglerBin();

// JSONC stripper — mirrors scripts/ensure-d1.mjs. We only parse for
// reads; writes go through targeted regex swaps so comments survive.
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const raw = readFileSync(wranglerPath, "utf8");
let config;
try {
  config = JSON.parse(stripJsonc(raw));
} catch (err) {
  console.error(`[ensure-kv] failed to parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

const workerName = config.name;
if (typeof workerName !== "string" || !workerName) {
  console.error("[ensure-kv] no top-level `name` in wrangler.jsonc");
  process.exit(1);
}

const kvBindings = (config.kv_namespaces || []).filter(
  (b) => b && typeof b.binding === "string",
);
if (kvBindings.length === 0) {
  console.log("[ensure-kv] no kv_namespaces declared, nothing to do");
  process.exit(0);
}

// Fast path: skip the API round-trip when we're running locally (not in
// Workers Builds) and every binding already has a populated id. Workers
// Builds always re-runs because its workspace is fresh on every build —
// we can't trust that pre-populated IDs are present there. Locally,
// repeat deploys after a successful one are the common case; this
// avoids the listing/creating API calls when there's nothing to do.
const isWorkersCi = process.env.WORKERS_CI === "1";
const allPopulated = kvBindings.every(
  (b) => typeof b.id === "string" && b.id.length > 0,
);
if (!isWorkersCi && allPopulated) {
  console.log(
    "[ensure-kv] all ids populated and not in Workers Builds, skipping API check",
  );
  process.exit(0);
}

// `wrangler kv namespace list` validates wrangler.jsonc before running
// and rejects empty `id` strings — exactly the state this script is
// meant to fix. Bypass that by running from a scratch directory with
// no wrangler.* config, so wrangler skips local config and just hits
// the API. The CLI is the supported entry point so we don't take a
// programmatic dep on wrangler's internals.
const scratchDir = mkdtempSync(join(tmpdir(), "ensure-kv-"));

// Wrap wrangler invocations so a multi-account auth failure surfaces a
// concrete action instead of a stack trace. Wrangler's own error
// message already mentions CLOUDFLARE_ACCOUNT_ID but our wrapper adds
// context (this is happening on prebuild, not on the user's deploy
// command).
function runWrangler(args, options = {}) {
  try {
    return execSync(`"${wranglerBin}" ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      cwd: scratchDir,
      ...options,
    });
  } catch (err) {
    console.error(
      "[ensure-kv] wrangler invocation failed. If the error above mentions multiple accounts, set CLOUDFLARE_ACCOUNT_ID before running:\n" +
        "  export CLOUDFLARE_ACCOUNT_ID=<your-account-id>\n" +
        "If wrangler isn't authenticated, run `npx wrangler login` first.",
    );
    process.exit(1);
  }
}

function listNamespaces() {
  const out = runWrangler("kv namespace list");
  // wrangler prints other lines before the JSON when warnings fire; grab
  // the first `[`-rooted block to be safe.
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start === -1 || end === -1) {
    console.error(
      "[ensure-kv] could not find JSON array in `wrangler kv namespace list` output",
    );
    console.error(out);
    process.exit(1);
  }
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch (err) {
    console.error(
      `[ensure-kv] failed to parse \`wrangler kv namespace list\` output: ${err.message}`,
    );
    console.error(out);
    process.exit(1);
  }
}

function createNamespace(title) {
  // Inherit stdio so the user sees wrangler's progress + any auth errors.
  // Run from scratch dir for the same reason as listNamespaces.
  runWrangler(`kv namespace create "${title}"`, { stdio: "inherit" });
}

// Normalise titles for fuzzy comparison. Wrangler's auto-provisioning
// lowercases bindings and renders `_` as `-` (e.g. `EGRESS_POLICIES`
// becomes `egress-policies`), so we have to collapse both before
// matching.
function normaliseForMatch(str) {
  return (str || "").toLowerCase().replace(/_/g, "-");
}

function findExisting(namespaces, binding) {
  const canonical = `${workerName}-${binding}`;
  const exact = namespaces.find((n) => n.title === canonical);
  if (exact) return exact;
  // Fuzzy fallback: previously-auto-provisioned namespaces typically use
  // `<worker>-<binding-lowercased-and-hyphenated>`. Normalise both sides
  // so e.g. `EGRESS_POLICIES` matches an existing `egress-policies`.
  const targetWorker = normaliseForMatch(workerName);
  const targetBinding = normaliseForMatch(binding);
  const fuzzy = namespaces.filter((n) => {
    const t = normaliseForMatch(n.title);
    return t.includes(targetWorker) && t.includes(targetBinding);
  });
  if (fuzzy.length === 1) return fuzzy[0];
  return null;
}

// Patches the `id` field inside the kv_namespaces entry that declares
// `"binding": "<binding>"`. Requires the entry to contain an `"id"`
// field (empty string is fine) so the swap is unambiguous.
function patchBindingId(text, binding, newId) {
  const bindingPattern = new RegExp(
    `"binding"\\s*:\\s*"${binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  const m = bindingPattern.exec(text);
  if (!m) return null;

  // Find the closing `}` of the binding's object literal.
  let end = m.index + m[0].length;
  let depth = 1;
  let inStr = false;
  let q = "";
  while (end < text.length) {
    const ch = text[end];
    if (inStr) {
      if (ch === "\\") {
        end += 2;
        continue;
      }
      if (ch === q) inStr = false;
      end++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      q = ch;
      end++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }
  if (end >= text.length) return null;

  // Walk back to the matching `{`.
  let start = m.index;
  let upDepth = 0;
  while (start > 0) {
    const ch = text[start];
    if (ch === "}") upDepth++;
    else if (ch === "{") {
      if (upDepth === 0) break;
      upDepth--;
    }
    start--;
  }

  const before = text.slice(0, start);
  const block = text.slice(start, end + 1);
  const after = text.slice(end + 1);

  const idRe = /("id"\s*:\s*")([^"]*)(")/;
  if (!idRe.test(block)) return null;
  return before + block.replace(idRe, `$1${newId}$3`) + after;
}

let namespaces = listNamespaces();
let nextText = raw;
let changed = false;

for (const b of kvBindings) {
  const binding = b.binding;
  let match = findExisting(namespaces, binding);

  let realId;
  if (match) {
    realId = match.id;
  } else {
    const title = `${workerName}-${binding}`;
    console.log(`[ensure-kv] creating KV namespace "${title}"`);
    createNamespace(title);
    namespaces = listNamespaces();
    match = findExisting(namespaces, binding);
    if (!match) {
      console.error(
        `[ensure-kv] namespace "${title}" not found after create — check wrangler output above`,
      );
      process.exit(1);
    }
    realId = match.id;
  }

  const currentId = typeof b.id === "string" ? b.id : "";
  if (currentId === realId) {
    console.log(
      `[ensure-kv] binding ${binding} → id "${realId}" matches (${match.title})`,
    );
    continue;
  }

  const patched = patchBindingId(nextText, binding, realId);
  if (!patched) {
    console.error(
      `[ensure-kv] could not patch id for binding "${binding}" — make sure its kv_namespaces entry contains \`"id": ""\``,
    );
    process.exit(1);
  }
  nextText = patched;
  changed = true;
  console.log(
    `[ensure-kv] binding ${binding} → id "${realId}" (${match.title})`,
  );
}

if (changed) {
  writeFileSync(wranglerPath, nextText);
}
