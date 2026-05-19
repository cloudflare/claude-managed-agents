import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { Workspace } from "@cloudflare/shell";
import { Agent } from "agents";
import type { FiberRecoveryContext } from "agents";
import { auditAgentTools } from "./audit";
import { fingerprintPolicy } from "./policy-fingerprint";
import { resolveSessionPolicy } from "../egress/resolve";
import type { CompiledPolicy } from "../egress/types";
import {
  isolateBrowserTools,
  isolateExecuteTool,
  isolateRunFileTool,
  isolateTools,
} from "./tools";
import { buildCfTools, cfToolGroups } from "../tools/cf";
import { ANTHROPIC_BETA } from "../anthropic";

// Wrap each tool so calls log start/end with timings. Without this, a
// hang anywhere in the dispatcher chain looks identical from the
// dashboard side.
function instrumentTools(
  tools: BetaRunnableTool[],
  sessionId: string,
): BetaRunnableTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args, ctx) => {
      const start = Date.now();
      console.log(
        `[isolate] tool=${t.name} start session=${sessionId} use_id=${ctx?.toolUse?.id ?? "(unknown)"}`,
      );
      try {
        const result = await t.run(args, ctx);
        const ms = Date.now() - start;
        const sample =
          typeof result === "string"
            ? result.length > 80
              ? `${result.slice(0, 80)}…`
              : result
            : "(blocks)";
        console.log(
          `[isolate] tool=${t.name} done  session=${sessionId} ms=${ms} result=${JSON.stringify(sample)}`,
        );
        return result;
      } catch (error) {
        const ms = Date.now() - start;
        console.error(
          `[isolate] tool=${t.name} threw session=${sessionId} ms=${ms} error=${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
  }));
}

// Idle timeout for the dispatcher's polling loop. When the session goes idle
// the dispatcher exits and the DO falls quiet — Anthropic re-dispatches new
// work via webhook, which calls `start()` again. Mirrors the MicroVM Sandbox
// runner's behaviour. Forwarded to `SessionToolRunner` as `maxIdleMs`.
const IDLE_MS = 60_000;

// Heartbeat cadence for the work-item lease. The old SDK's `ToolDispatcher`
// owned this internally; under the 0.96 SDK `SessionToolRunner` is dispatch-
// only so we own the heartbeat. 20s gives the lease ~3x headroom against the
// server's default 60s TTL — the same headroom the SDK's `EnvironmentWorker`
// uses internally.
const HEARTBEAT_INTERVAL_MS = 20_000;

// Stable name passed to `runFiber()` so eviction recovery can match the
// dispatcher fiber and re-establish it from persisted state.
const DISPATCHER_FIBER = "isolate-dispatcher";

export interface IsolateStartOpts {
  sessionId: string;
  workId: string;
  environmentId: string;
  baseURL: string;
  // Optional — when provided we run a startup audit on the agent's tool
  // catalog so misconfigured agents (e.g. saved before the cf_*
  // prefix fix) emit a loud warning instead of silently hanging.
  agentId?: string | null;
}

// Durable state stored in `cf_agents_state` (the Agents SDK's built-in
// state table). Survives DO eviction so the fiber-recovery hook can
// re-establish the dispatcher with the same session/work identifiers
// after a cold wake, and the drift detector keeps its tool/policy
// fingerprints across restarts instead of resetting on every wake.
//
// Note: there is no per-work-item session token any more — under the
// 0.96 SDK / ant 1.8 release the Worker's `ANTHROPIC_ENVIRONMENT_KEY`
// authenticates every call the control plane makes. So state only carries the
// identifiers needed to re-attach to an existing work item on recovery.
export interface IsolateSessionState {
  sessionId: string | null;
  workId: string | null;
  environmentId: string | null;
  baseURL: string | null;
  agentId: string | null;
  registeredToolNames: string[];
  registeredPolicyFingerprint: string | null;
  startedAt: number | null;
}

const EMPTY_STATE: IsolateSessionState = {
  sessionId: null,
  workId: null,
  environmentId: null,
  baseURL: null,
  agentId: null,
  registeredToolNames: [],
  registeredPolicyFingerprint: null,
  startedAt: null,
};

// One DO per session, keyed by `idFromName(sessionId)`. We extend
// Cloudflare's Agent base class (built on Durable Objects) so the
// runner gets:
//   - Persistent `this.state` via `cf_agents_state` (drift fingerprints,
//     session credentials).
//   - Durable fibers via `runFiber()` — the dispatcher survives DO
//     eviction; an interrupted fiber is detected on next wake and
//     `onFiberRecovered()` re-establishes it from state.
//   - First-party "built on the Agents SDK" positioning for downstream
//     docs/users.
// We extend `Agent`, not `Think` — `Think` ships its own chat loop that
// would fight the Anthropic-server-side agent loop. The bits we want
// (Workspace, durable fibers, persisted state) live on the base class.
export class IsolateRunner extends Agent<Env, IsolateSessionState> {
  // Default state used the first time the DO wakes after the migration
  // from `extends DurableObject`. After that, Agents SDK persists state
  // in SQLite and `this.state` reads from there.
  initialState: IsolateSessionState = EMPTY_STATE;

  // The workspace lives for the DO's lifetime and persists in the same
  // SQLite storage the DO already owns. Class-field init runs after
  // `super()`, so `this.ctx` is available. Workspace's tables are
  // namespaced and don't collide with the SDK's `cf_agents_*` tables.
  workspace: Workspace = new Workspace({
    sql: this.ctx.storage.sql,
    // The DO doesn't expose `name` from idFromName(), so use a stable
    // namespace label and let the session id flow through tools.
    name: () => "isolate-runner",
  });

  // Aborts the in-flight dispatcher fiber. Lives in-memory only — after
  // eviction `ctrl` is gone, but the fiber row in `cf_agents_runs`
  // remains, so `onFiberRecovered()` knows we were interrupted.
  private ctrl: AbortController | undefined;

  async isLive(): Promise<boolean> {
    return this.ctrl !== undefined && !this.ctrl.signal.aborted;
  }

  // The set of tool names we'd register if start() were called right now.
  // Mirrors the conditional logic further down (LOADER → execute +
  // run_file, LOADER+BROWSER → browser tools). Kept as a string-only
  // computation so we can compare against a running dispatcher cheaply
  // before deciding to restart it.
  private computeDesiredToolNames(): string[] {
    // Names must match the registry in `tool-registry.ts`. cf_read /
    // cf_write / cf_edit / cf_grep keep the prefix to avoid colliding
    // with the Anthropic stock toolset entries of the same name; every
    // other workspace + power tool ships unprefixed.
    const names = [
      "cf_read",
      "cf_write",
      "cf_edit",
      "list",
      "find",
      "cf_grep",
      "delete",
    ];
    if (this.env.LOADER) {
      names.push("execute", "run_file");
    }
    if (this.env.LOADER && this.env.BROWSER) {
      names.push("browser_search", "browser_execute");
    }
    // Worker-binding-backed tools (Browser Rendering REST, Workers AI,
    // VPC, Email) plus user-defined tools from src/tools/custom-tools.ts.
    // Each group is independently gated on the relevant
    // binding/secret; cfToolGroups inspects the env once and returns
    // which names are live. Drift detection compares the full set so a
    // mid-deploy binding flip or custom-tool change restarts the
    // dispatcher.
    const groups = cfToolGroups(this.env);
    if (groups.browser.enabled) names.push(...groups.browser.names);
    if (groups.ai.enabled) names.push(...groups.ai.names);
    if (groups.vpc.enabled) names.push(...groups.vpc.names);
    if (groups.email.enabled) names.push(...groups.email.names);
    if (groups.custom.enabled) names.push(...groups.custom.names);
    return names;
  }

  // Returns true when the persisted registered names match `desired`. Used
  // to decide whether a live dispatcher can be reused or has to be torn
  // down because the code that built it is stale.
  private toolNamesMatch(desired: string[]): boolean {
    const registered = this.state.registeredToolNames;
    if (!registered || registered.length === 0) return false;
    if (registered.length !== desired.length) return false;
    const a = [...registered].sort();
    const b = [...desired].sort();
    return a.every((name, i) => name === b[i]);
  }

  // Boot the dispatcher detached. Anthropic streams `agent.custom_tool_use`
  // events to it; the dispatcher executes them locally against the
  // Workspace and posts back `user.custom_tool_result`. The dispatcher
  // also drives the work-item heartbeat and exits cleanly on stop signal
  // or idle timeout.
  async start(opts: IsolateStartOpts): Promise<void> {
    // Compute the desired tool names up front so we can compare against the
    // running dispatcher (if any). Cheap — just a name list, the actual
    // BetaRunnableTool instances aren't built until we know we need them.
    const desiredNames = this.computeDesiredToolNames();

    // Resolve the matching egress policy for this session before we decide
    // whether the running dispatcher can be reused. The fingerprint
    // comparison below uses this fresh resolution to catch mid-session
    // policy edits — without it, the dispatcher would keep enforcing the
    // policy snapshot taken on initial boot. Same lookup the MicroVM
    // Sandbox path uses, so a single policy edit applies to either backend.
    const policy = await resolveSessionPolicy(this.env, opts.sessionId);
    const desiredPolicyFp = await fingerprintPolicy(policy);

    if (await this.isLive()) {
      const toolsOk = this.toolNamesMatch(desiredNames);
      const policyOk =
        this.state.registeredPolicyFingerprint === desiredPolicyFp;
      if (toolsOk && policyOk) {
        console.log(
          `[isolate] dispatcher already live for session=${opts.sessionId}, skipping start`,
        );
        return;
      }
      // Names or policy changed. Abort the running dispatcher and wait
      // briefly for it to unwind so we don't run two dispatchers
      // heartbeat-fighting over the same work item. drain() inside the
      // dispatcher waits up to 30s for in-flight tool calls; we cap our
      // wait at ~32s.
      const reasons: string[] = [];
      if (!toolsOk) {
        reasons.push(
          `tools old=${this.state.registeredToolNames.join(",") || "(none)"} new=${desiredNames.join(",")}`,
        );
      }
      if (!policyOk) {
        reasons.push(
          `policy old=${this.state.registeredPolicyFingerprint ?? "(none)"} new=${desiredPolicyFp}`,
        );
      }
      console.warn(
        `[isolate] dispatcher drift detected session=${opts.sessionId} — restarting (${reasons.join("; ")})`,
      );
      this.ctrl?.abort();
      const waitStart = Date.now();
      while (this.ctrl !== undefined && Date.now() - waitStart < 32_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (this.ctrl !== undefined) {
        console.warn(
          `[isolate] previous dispatcher did not exit within 32s session=${opts.sessionId} — proceeding anyway`,
        );
        this.ctrl = undefined;
      }
    }

    // Persist the session identifiers BEFORE booting the dispatcher so
    // `onFiberRecovered()` has everything it needs if we're evicted
    // mid-boot. Under the new auth model the environment key (held by
    // the Worker, not in state) is what authenticates every call — so
    // recovery is just the identifiers, no token to refresh.
    this.setState({
      ...this.state,
      sessionId: opts.sessionId,
      workId: opts.workId,
      environmentId: opts.environmentId,
      baseURL: opts.baseURL,
      agentId: opts.agentId ?? null,
      startedAt: Date.now(),
    });

    await this.bootDispatcher(opts, policy, desiredPolicyFp, desiredNames);
  }

  // Internal: build the tool catalog, attach the gateway, and launch the
  // two dispatchers inside a durable fiber. Shared between `start()`
  // (webhook-driven boot) and `onFiberRecovered()` (eviction recovery).
  private async bootDispatcher(
    opts: IsolateStartOpts,
    policy: CompiledPolicy | null,
    desiredPolicyFp: string,
    desiredNames: string[],
  ): Promise<void> {
    this.ctrl = new AbortController();

    // Under the 0.96 SDK the environment key is the single credential —
    // it authenticates work poll/ack/heartbeat/force-stop AND the per-
    // session event stream + skill download. The old per-work session
    // token plumbing is gone, and `ToolDispatcher` along with it; we now
    // compose `SessionToolRunner` (dispatch only) with a hand-rolled
    // heartbeat + force-stop loop below.
    if (!this.env.ANTHROPIC_ENVIRONMENT_KEY) {
      throw new Error(
        "ANTHROPIC_ENVIRONMENT_KEY is required for Isolate Sandbox sessions — the control plane uses it to authenticate every call (heartbeat, force-stop, event stream, tool result posting).",
      );
    }
    // Surface a fingerprint of the key actually in use. Log the first 16
    // chars (covers the `sk-ant-oat01-` prefix + 4 of the body) and last
    // 4 chars so a 401 here can be triaged against the value in
    // `wrangler secret list` / the Console without leaking the secret.
    const ek = this.env.ANTHROPIC_ENVIRONMENT_KEY;
    console.log(
      `[isolate] env-key fingerprint session=${opts.sessionId} len=${ek.length} prefix=${ek.slice(0, 16)} suffix=${ek.slice(-4)}`,
    );
    // apiKey: null avoids the SDK's process.env backfill, which would
    // send both bearer + x-api-key and trip the managed-agents 401.
    // (Same rationale as `bearerClient` in src/webhooks.ts.)
    const client = new Anthropic({
      apiKey: null,
      authToken: ek,
      baseURL: opts.baseURL,
    });

    const tools: BetaRunnableTool[] = isolateTools({
      workspace: this.workspace,
      sessionId: opts.sessionId,
    });

    // `policy` was resolved at the top of start() so the drift check
    // above could use it. Log the binding here, where it actually
    // attaches to the gateway, so the operator sees one line per fresh
    // dispatcher rather than one per start() call that ended in reuse.
    if (policy) {
      console.log(
        `[isolate] applying egress policy=${policy.policyId} (${policy.policyName}) session=${opts.sessionId}`,
      );
    }

    // Outbound gateway via the dynamic-Worker egress-control pattern.
    // ctx.exports.IsolateOutboundGateway() returns a real `Fetcher`
    // capability that workerd accepts for `globalOutbound`; props ride
    // along on every call so applyEgressPolicy() can correlate logs
    // and enforce the session's policy.
    // https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
    const outbound = this.ctx.exports.IsolateOutboundGateway({
      props: { sessionId: opts.sessionId, policy },
    });

    // Power tools register independently so a missing BROWSER doesn't
    // prevent code execution from working.
    if (this.env.LOADER) {
      try {
        tools.push(
          await isolateExecuteTool({
            workspace: this.workspace,
            loader: this.env.LOADER,
            globalOutbound: outbound,
          }),
        );
      } catch (error) {
        console.warn(
          `[isolate] failed to register execute tool session=${opts.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // run_file bypasses the eval/new Function block by loading
      // the file as a Worker module at compile time.
      try {
        tools.push(
          isolateRunFileTool({
            workspace: this.workspace,
            loader: this.env.LOADER,
            sessionId: opts.sessionId,
            globalOutbound: outbound,
          }),
        );
      } catch (error) {
        console.warn(
          `[isolate] failed to register run_file tool session=${opts.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // BROWSER ships declared in wrangler.jsonc but we still treat it as
    // optional at runtime — local dev environments running without the
    // binding shouldn't fail to register the rest of the toolset.
    if (this.env.LOADER && this.env.BROWSER) {
      try {
        tools.push(
          ...(await isolateBrowserTools({
            loader: this.env.LOADER,
            browser: this.env.BROWSER,
          })),
        );
      } catch (error) {
        console.warn(
          `[isolate] failed to register browser tools session=${opts.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Cloudflare-binding-backed tools — Browser Rendering REST,
    // Workers AI image gen, VPC service caller, Email send/inbox.
    // Each is independently gated on the relevant binding/secret so a
    // user can opt in to a subset by configuring only what they need.
    // Build them all in one shot via buildCfTools(); missing-binding
    // factories return null and are filtered out.
    try {
      const cfTools = buildCfTools({
        workspace: this.workspace,
        env: this.env,
        sessionId: opts.sessionId,
      });
      if (cfTools.length > 0) {
        console.log(
          `[isolate] registering ${cfTools.length} cf tools session=${opts.sessionId} names=${cfTools.map((t) => t.name).join(",")}`,
        );
        tools.push(...cfTools);
      }
    } catch (error) {
      console.warn(
        `[isolate] failed to register cf tools session=${opts.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Audit before the dispatcher attaches. `auditAgentTools` logs
    // whether the agent's saved tool list looks sane — catches the
    // common failure mode where an agent saved before the prefix fix
    // still has `agent_toolset_20260401` as its tool wrapper. The
    // 0.96 SDK's `SessionToolRunner` answers stray `agent.tool_use`
    // events with "tool not implemented" on its own reconcile pass,
    // so we no longer hand-roll that fallback.
    if (opts.agentId) {
      try {
        await auditAgentTools(client, opts.agentId, opts.sessionId);
      } catch (error) {
        console.warn(
          `[isolate] audit failed session=${opts.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const instrumented = instrumentTools(tools, opts.sessionId);
    // Two concurrent loops, both sharing `this.ctrl.signal`:
    //   1. SessionToolRunner — SDK runner that streams session events
    //      and answers BOTH `agent.tool_use` and `agent.custom_tool_use`
    //      calls against the registered tool list. It also reconciles
    //      past events on every (re)connect, so calls that arrived
    //      while the DO was asleep get picked up on the next wake.
    //   2. heartbeatLoop — owns the work-item lease and aborts when
    //      the platform signals shutdown (`state: stopping/stopped`).
    // On exit we force-stop the work item so the lease releases cleanly.
    //
    // We used to run a third loop (`runCustomToolDispatcher`) here as a
    // belt-and-braces handler for `agent.custom_tool_use` events. The
    // 0.96 SDK's `SessionToolRunner` covers both event types AND the
    // reconcile-on-reconnect path, so the parallel dispatcher was
    // strictly redundant. It also raced the SDK runner: if its view of
    // `tools` was momentarily incomplete it would post a misleading
    // `tool "<name>" not implemented` result before the SDK could
    // answer correctly, and the model saw that string. Dropped — the
    // SDK runner is the single source of truth now.
    //
    // TODO: skills aren't downloaded for Isolate sessions yet — the
    // SDK's setupSkills uses Node fs/path which can't run in a DO.
    // Wire a Workers-compatible variant in here when one lands.
    console.log(
      `[isolate] dispatcher starting session=${opts.sessionId} work=${opts.workId} tools=${tools.length} names=${tools.map((t) => t.name).join(",")}`,
    );

    // Snapshot the names + policy fingerprint so a subsequent start()
    // can detect drift in either and restart instead of reusing the
    // stale dispatcher / gateway. Persisted via setState so the values
    // survive eviction and the recovery path can re-check them.
    this.setState({
      ...this.state,
      registeredToolNames: tools.map((t) => t.name),
      registeredPolicyFingerprint: desiredPolicyFp,
    });
    void desiredNames;

    // Detached durable run — `runFiber` registers a row in
    // `cf_agents_runs` before the work starts, holds `keepAlive` for the
    // duration, and (on eviction) leaves the row behind so the next wake
    // calls `onFiberRecovered()`. We don't await it; the webhook handler
    // returns immediately and the two loops run in the background.
    const signal = this.ctrl.signal;
    const { workId, environmentId, sessionId } = opts;
    void this.runFiber(DISPATCHER_FIBER, async () => {
      try {
        await Promise.allSettled([
          drainSessionToolRunner({
            client,
            sessionId,
            tools: instrumented,
            signal,
          }).catch((error) => {
            console.error(
              `[isolate] session-tool-runner failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
          runHeartbeatLoop({
            client,
            workId,
            environmentId,
            signal,
            abort: () => this.ctrl?.abort(),
          }).catch((error) => {
            console.error(
              `[isolate] heartbeat loop failed session=${sessionId} work=${workId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ]);
      } finally {
        console.log(`[isolate] dispatcher exited session=${sessionId}`);
        this.ctrl = undefined;
        // Force-stop the work item so the lease releases regardless of
        // why the loops exited. Best-effort: a 4xx here (item already
        // stopped, etc.) is logged and swallowed. Run before clearing
        // state so the work id is still in scope.
        try {
          await client.beta.environments.work.stop(workId, {
            environment_id: environmentId,
            force: true,
            betas: [ANTHROPIC_BETA],
          });
        } catch (error) {
          console.warn(
            `[isolate] force-stop failed session=${sessionId} work=${workId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Clear the registered-tool fingerprint on clean exit so the next
        // start() can't accidentally reuse a stale snapshot. Identifiers
        // stay in state — `onFiberRecovered()` reuses them if we're
        // evicted before a clean exit.
        this.setState({
          ...this.state,
          registeredToolNames: [],
          registeredPolicyFingerprint: null,
        });
      }
    });
  }

  // Called by the Agents SDK alarm-housekeeping path when an interrupted
  // `runFiber()` row is detected after the DO wakes from eviction. We
  // try to re-establish the dispatcher with the session credentials
  // we stashed in state — if the token has expired, the heartbeat will
  // fail and the dispatcher will exit; the next Anthropic webhook then
  // boots us fresh with a new token via `start()`.
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    if (ctx.name !== DISPATCHER_FIBER) return;

    const s = this.state;
    if (!s.sessionId || !s.workId || !s.environmentId || !s.baseURL) {
      console.warn(
        `[isolate] fiber recovery skipped — missing session state (sessionId=${s.sessionId ?? "(none)"})`,
      );
      return;
    }

    const ageMs = Date.now() - (s.startedAt ?? 0);
    console.log(
      `[isolate] fiber recovery session=${s.sessionId} work=${s.workId} ageMs=${ageMs}`,
    );

    const opts: IsolateStartOpts = {
      sessionId: s.sessionId,
      workId: s.workId,
      environmentId: s.environmentId,
      baseURL: s.baseURL,
      agentId: s.agentId,
    };

    try {
      const policy = await resolveSessionPolicy(this.env, s.sessionId);
      const desiredPolicyFp = await fingerprintPolicy(policy);
      const desiredNames = this.computeDesiredToolNames();
      await this.bootDispatcher(opts, policy, desiredPolicyFp, desiredNames);
    } catch (error) {
      console.error(
        `[isolate] fiber recovery failed session=${s.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Aborts the dispatcher's poll loop. The dispatcher will drain in-flight
  // tool calls before exiting (see ToolDispatcher.drain).
  async stop(): Promise<void> {
    this.ctrl?.abort();
  }

  // Exposed for /api/environments/:id/status to report session liveness in
  // the same shape as the MicroVM Sandbox path. We don't have a granular
  // container state, so we collapse to running/stopped.
  async getStatus(): Promise<"running" | "stopped"> {
    return (await this.isLive()) ? "running" : "stopped";
  }

  // Cheap workspace introspection used by the frontend file browser. Each
  // entry carries the same `FileInfo` shape Workspace itself returns —
  // serialisable across the DO RPC boundary because it's a plain object
  // (no Date, no Map, no class instances).
  async readDir(
    prefix = "/",
    opts: { limit?: number; offset?: number } = {},
  ): Promise<WorkspaceEntry[]> {
    const entries = await this.workspace.readDir(prefix, {
      limit: opts.limit ?? 500,
      offset: opts.offset ?? 0,
    });
    return entries.map(toWorkspaceEntry);
  }

  // Read a workspace file as UTF-8 text plus its `FileInfo` (so the caller
  // can render mime-type / size / mtime without a second round-trip).
  // Returns `null` when the path doesn't exist or stats as a directory.
  async readFile(
    path: string,
  ): Promise<{ entry: WorkspaceEntry; content: string } | null> {
    const stat = await this.workspace.stat(path);
    if (!stat || stat.type !== "file") return null;
    const content = (await this.workspace.readFile(path)) ?? "";
    return { entry: toWorkspaceEntry(stat), content };
  }

  // Whole-workspace summary for the file-browser header.
  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.workspace.getWorkspaceInfo();
  }
}

// Plain-object projection of Workspace's `FileInfo` so the DO RPC boundary
// only carries data it can serialise. Defined alongside the control plane so other
// modules importing the control plane type also get this companion shape.
export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

function toWorkspaceEntry(e: {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}): WorkspaceEntry {
  return {
    path: e.path,
    name: e.name,
    type: e.type,
    mimeType: e.mimeType,
    size: e.size,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// Drive the SDK's `SessionToolRunner` to completion. The control plane is an
// async-iterable that streams session events, dispatches each
// `agent.tool_use` / `agent.custom_tool_use` against the local tool
// registry, posts the result back, and yields one `DispatchedToolCall`
// per completed call. It exits when the session terminates, the signal
// aborts, or `maxIdleMs` elapses past an `end_turn` idle. We only
// drain — the consumer log lives in `instrumentTools()` already.
async function drainSessionToolRunner(opts: {
  client: Anthropic;
  sessionId: string;
  tools: BetaRunnableTool[];
  signal: AbortSignal;
}): Promise<void> {
  const runner = opts.client.beta.sessions.events.toolRunner(opts.sessionId, {
    tools: opts.tools,
    signal: opts.signal,
    maxIdleMs: IDLE_MS,
  });
  for await (const call of runner) {
    if (opts.signal.aborted) break;
    // Logging happens in `instrumentTools()` (per-call) and at the
    // session level via the surrounding console.log. We swallow the
    // yielded `DispatchedToolCall` because there's nothing actionable
    // to do with it here.
    void call;
  }
}

// Hand-rolled work-item heartbeat loop. The old SDK's `ToolDispatcher`
// owned this; `SessionToolRunner` is dispatch-only so the caller owns
// the lease.
//
// Protocol (see `WorkHeartbeatParams` in the SDK types):
//   - First heartbeat sends `expected_last_heartbeat: "NO_HEARTBEAT"`
//     to claim an unclaimed lease.
//   - Each subsequent heartbeat echoes back the server's previous
//     `last_heartbeat` value for optimistic concurrency. A 412 means
//     someone else claimed the lease — we bail and let the control plane exit.
//   - The response's `state` field tells us when the platform wants the
//     work item to stop (`stopping` / `stopped`); we call `abort()` on
//     the shared controller so the dispatchers unwind.
async function runHeartbeatLoop(opts: {
  client: Anthropic;
  workId: string;
  environmentId: string;
  signal: AbortSignal;
  abort: () => void;
}): Promise<void> {
  let lastHeartbeat: string | null = null;
  while (!opts.signal.aborted) {
    try {
      const response = await opts.client.beta.environments.work.heartbeat(
        opts.workId,
        {
          environment_id: opts.environmentId,
          expected_last_heartbeat: lastHeartbeat ?? "NO_HEARTBEAT",
          betas: [ANTHROPIC_BETA],
        },
        { signal: opts.signal },
      );
      lastHeartbeat = response.last_heartbeat;
      if (response.state === "stopping" || response.state === "stopped") {
        console.log(
          `[isolate] heartbeat state=${response.state} work=${opts.workId} — aborting runner`,
        );
        opts.abort();
        return;
      }
      if (!response.lease_extended) {
        console.warn(
          `[isolate] heartbeat lease not extended work=${opts.workId} — aborting runner`,
        );
        opts.abort();
        return;
      }
    } catch (error) {
      if (opts.signal.aborted) return;
      // 412 (precondition failed) means our `expected_last_heartbeat`
      // didn't match — the lease moved on without us. 4xx generally is
      // fatal; we abort the control plane and let the next webhook reclaim.
      const status = (error as { status?: number })?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        console.warn(
          `[isolate] heartbeat ${status} work=${opts.workId} — aborting runner: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        opts.abort();
        return;
      }
      console.warn(
        `[isolate] heartbeat transient error work=${opts.workId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Fall through to the sleep; we'll retry on the next tick.
    }
    await sleep(HEARTBEAT_INTERVAL_MS, opts.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function getIsolateRunner(env: Env, sessionId: string) {
  const id = env.IsolateRunner.idFromName(sessionId);
  return env.IsolateRunner.get(id) as DurableObjectStub<IsolateRunner>;
}
