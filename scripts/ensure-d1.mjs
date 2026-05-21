#!/usr/bin/env node
//
// Ensures the D1 database declared in wrangler.jsonc exists in the
// current Cloudflare account, creating it if necessary, and patches the
// real `database_id` into wrangler.jsonc.
//
// Why this exists:
//   A first-time deploy would otherwise require a manual
//   `wrangler d1 create claude-managed-agents` followed by a hand-edit to
//   paste the new UUID into wrangler.jsonc. This script removes both
//   steps so `npm run deploy` is the only command a fresh operator has
//   to run.
//
// How it works:
//   1. Parse wrangler.jsonc → read `d1_databases[0].database_name`.
//   2. `wrangler d1 list --json` → look for a DB with that name in the
//      currently-authenticated account.
//   3. If absent, `wrangler d1 create <name>` and re-list to capture
//      the new UUID.
//   4. If wrangler.jsonc's `database_id` doesn't match the real one,
//      regex-swap it in place. We avoid parsing+reserialising the JSONC
//      so comments, trailing commas, and indentation survive.
//
// Idempotent: if the DB exists and the ID already matches, wrangler.jsonc
// is not rewritten.
//
// Prerequisites: wrangler must be authenticated (either `wrangler login`
// or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars). Deploy
// itself needs the same credentials, so this isn't an extra burden.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const wranglerPath = resolve(repoRoot, "wrangler.jsonc");

// Locate the wrangler binary explicitly — see ensure-kv.mjs for the
// rationale (npx --no-install can't find a project-local wrangler
// when cwd is /tmp in Workers Builds).
function resolveWranglerBin() {
  const local = resolve(repoRoot, "node_modules", ".bin", "wrangler");
  if (existsSync(local)) return local;
  return "wrangler";
}
const wranglerBin = resolveWranglerBin();

// `wrangler d1 list` validates the project's wrangler.jsonc before
// running, which fails when ensure-kv.mjs hasn't yet populated the
// kv_namespaces `id` fields (empty strings trip the schema check). Run
// list/create from a scratch dir with no wrangler.* config so wrangler
// skips local config validation and just hits the API. This also lets
// ensure-d1 and ensure-kv run in either order.
const scratchDir = mkdtempSync(join(tmpdir(), "ensure-d1-"));

// JSONC stripper — same approach as sync-vpc-bindings.mjs. We only need
// to parse wrangler.jsonc; we never write through this path, so dropping
// comments here is fine.
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
  console.error(`[ensure-d1] failed to parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

const dbConfig = (config.d1_databases || [])[0];
if (!dbConfig || typeof dbConfig.database_name !== "string") {
  console.error(
    "[ensure-d1] no d1_databases[0].database_name in wrangler.jsonc",
  );
  process.exit(1);
}
const dbName = dbConfig.database_name;

// Fast path: skip the API round-trip locally when database_id is
// already populated. Workers Builds always re-runs because the
// workspace is fresh on every build. See ensure-kv.mjs for the same
// pattern.
const isWorkersCi = process.env.WORKERS_CI === "1";
const currentDbId =
  typeof dbConfig.database_id === "string" ? dbConfig.database_id : "";
if (!isWorkersCi && currentDbId.length > 0) {
  console.log(
    "[ensure-d1] database_id populated and not in Workers Builds, skipping API check",
  );
  process.exit(0);
}

// Wrap wrangler invocations so a multi-account auth failure surfaces a
// concrete action instead of a stack trace.
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
      "[ensure-d1] wrangler invocation failed. If the error above mentions multiple accounts, set CLOUDFLARE_ACCOUNT_ID before running:\n" +
        "  export CLOUDFLARE_ACCOUNT_ID=<your-account-id>\n" +
        "If wrangler isn't authenticated, run `npx wrangler login` first.",
    );
    process.exit(1);
  }
}

// `wrangler d1 list --json` prints a clean JSON array to stdout. We
// shell out via the CLI so we don't have to take a wrangler programmatic
// dep — the CLI is the supported entry point.
function listDatabases() {
  const out = runWrangler("d1 list --json");
  try {
    return JSON.parse(out);
  } catch (err) {
    console.error(
      `[ensure-d1] failed to parse \`wrangler d1 list --json\` output: ${err.message}`,
    );
    console.error(out);
    process.exit(1);
  }
}

let dbs = listDatabases();
let match = dbs.find((d) => d.name === dbName);

if (!match) {
  console.log(`[ensure-d1] creating D1 database "${dbName}"`);
  // Inherit stdio so the user sees wrangler's progress + any auth errors.
  runWrangler(`d1 create ${dbName}`, { stdio: "inherit" });
  dbs = listDatabases();
  match = dbs.find((d) => d.name === dbName);
  if (!match) {
    console.error(
      `[ensure-d1] "${dbName}" not found after create — check wrangler output above`,
    );
    process.exit(1);
  }
}

const realId = match.uuid;
const currentId =
  typeof dbConfig.database_id === "string" ? dbConfig.database_id : "";
if (currentId === realId) {
  console.log(
    `[ensure-d1] database "${dbName}" exists, id "${realId}" matches`,
  );
  process.exit(0);
}

// Use `[^"]*` rather than `[^"]+` so an empty `"database_id": ""` still
// matches and gets filled in.
const re = /("database_id"\s*:\s*")([^"]*)(")/;
if (!re.test(raw)) {
  console.error(
    '[ensure-d1] database_id field not found in wrangler.jsonc — add `"database_id": "",` next to database_name',
  );
  process.exit(1);
}
const nextText = raw.replace(re, `$1${realId}$3`);
writeFileSync(wranglerPath, nextText);
console.log(`[ensure-d1] database_id ${currentId || "(empty)"} → ${realId}`);
