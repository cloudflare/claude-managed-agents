import { ContainerProxy } from "@cloudflare/sandbox";
import { apiApp } from "./api";
import { buildOpenApiSpec } from "./api/openapi";
import { Sandbox, getSessionSandbox } from "./microvm/sandbox";
import { IsolateRunner } from "./isolate/runner";
import { IsolateOutboundGateway } from "./isolate/gateway";
import { handleWebhook, resolveBackend } from "./webhooks";
import { isSessionId } from "./helpers";
import { pruneOlderThan } from "./storage";
import { handleEmail, type ForwardableEmailMessage } from "./email-handler";
import { requireDashboardAuth } from "./auth";

// `ContainerProxy` must be re-exported from the worker entrypoint — the
// MicroVM Sandbox SDK looks it up via `ctx.exports.ContainerProxy` to
// route outbound HTTP traffic from the container through our outbound
// handlers. Without this export, dispatch fails with
// "ContainerProxy is undefined".
//
// `IsolateRunner` is the second-flavour session backend (Workspace +
// Anthropic SessionToolRunner in a Worker DO; no container) — re-exported
// so wrangler can bind it as a Durable Object class. The class was
// previously named `ThinkRunner`; v3 wrangler migration renames it.
//
// `IsolateOutboundGateway` is the WorkerEntrypoint we use as
// `globalOutbound` for Isolate-Sandbox dynamic Workers, accessed via
// `ctx.exports.IsolateOutboundGateway` inside the control plane DO. It's
// required by the Cloudflare runtime's egress-control pattern — see
// https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
export { Sandbox, IsolateRunner, IsolateOutboundGateway, ContainerProxy };

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhooks" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    const authFailure = await requireDashboardAuth(request, env);
    if (authFailure) {
      return authFailure;
    }

    // PTY terminal WebSocket upgrade. The frontend opens
    // `ws(s)://<host>/ws/terminal?session=<id>&cols=<n>&rows=<n>` and pipes
    // it to xterm.js. We forward the upgrade request to the matching
    // Sandbox DO, which proxies to the in-container PTY runtime.
    if (url.pathname === "/ws/terminal") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const sessionId = url.searchParams.get("session") ?? "";
      if (!isSessionId(sessionId)) {
        return new Response("invalid session id", { status: 400 });
      }
      const cols = Number.parseInt(url.searchParams.get("cols") ?? "", 10);
      const rows = Number.parseInt(url.searchParams.get("rows") ?? "", 10);
      const opts: { cols?: number; rows?: number } = {};
      if (Number.isFinite(cols) && cols > 0) opts.cols = cols;
      if (Number.isFinite(rows) && rows > 0) opts.rows = rows;

      // Isolate-Sandbox sessions have no shell — reject the upgrade with
      // a 409 + plain-text reason so the frontend can surface a clear
      // error.
      try {
        const { backend } = await resolveBackend(env, sessionId);
        if (backend === "isolate") {
          return new Response(
            "terminal not available — this session uses an Isolate Sandbox (no shell)",
            { status: 409 },
          );
        }

        const sandbox = getSessionSandbox(env, sessionId);
        // Block the PTY upgrade until the container is booted AND the
        // most-recent /workspace snapshot has been restored. Without
        // this, the operator could open a terminal against a cold
        // container, start typing into /workspace, and have their work
        // clobbered the moment restoreBackup() lands. ensureStarted is
        // idempotent + concurrent-safe so a dispatch racing with a
        // terminal open will share the same restore.
        await sandbox.ensureStarted();
        // `terminal()` is wired up by `getSandbox()` at runtime but isn't
        // surfaced in the public TypeScript type — see `proxyTerminal()` in
        // @cloudflare/sandbox. Cast to call it.
        const stub = sandbox as unknown as {
          terminal(req: Request, opts?: { cols?: number; rows?: number }): Promise<Response>;
        };
        return await stub.terminal(request, opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ws] terminal open failed for ${sessionId}: ${message}`);
        return new Response(`terminal unavailable: ${message}`, {
          status: 502,
        });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return apiApp.fetch(request, env);
    }

    // Discoverable OpenAPI document at the conventional root path.
    // Tools like `openapi-typescript`, `oapi-codegen`, openapi-cli, and
    // most LLM agents that "look up the spec" probe `/openapi.json`
    // (and sometimes `/openapi.yaml`) before falling back. We serve the
    // same document `/api/openapi.json` returns, with CORS open so
    // browser-side agents (Claude tool-use, GPT actions, etc.) can
    // fetch it cross-origin without a proxy.
    if (
      (url.pathname === "/openapi.json" || url.pathname === "/openapi") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const spec = buildOpenApiSpec(url.origin);
      return new Response(JSON.stringify(spec), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          // Public, cacheable metadata. 5-min edge cache keeps CLI
          // tooling fast without hiding intra-day schema changes.
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
        },
      });
    }

    // CORS preflight for the OpenAPI alias — agents calling from a
    // browser context will issue an OPTIONS before the GET.
    if (
      (url.pathname === "/openapi.json" || url.pathname === "/openapi") &&
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },

  // Email Routing entrypoint. Invoked by Cloudflare Email Routing when a
  // message lands on a route that targets this Worker. Configure your
  // catch-all rule in the dashboard to point here; the handler extracts
  // the session id from the local-part and persists the message to D1.
  // No-op when EMAIL_DOMAIN isn't configured / no DB binding exists.
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleEmail(message, env));
  },

  // Daily prune of webhook_events and sessions older than 24h. Configured in
  // wrangler.jsonc as `0 4 * * *` (4 AM UTC).
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cutoff = Date.now() - ONE_DAY_MS;
    ctx.waitUntil(
      (async () => {
        try {
          const result = await pruneOlderThan(env.DB, cutoff);
          console.log(
            `[cron] prune events=${result.events} sessions=${result.sessions} inbox=${result.inbox} sentMessages=${result.sentMessages} cutoff=${new Date(cutoff).toISOString()}`,
          );
        } catch (error) {
          console.error("[cron] prune failed", error);
        }
      })(),
    );
  },
};
