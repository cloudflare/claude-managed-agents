import Anthropic from "@anthropic-ai/sdk";
import { getSessionSandbox, SESSION_IDLE_TTL } from "./microvm/sandbox";
import { getIsolateRunner } from "./isolate/runner";
import {
  ensureAgentPrimaryEmail,
  getAgentBackend,
  getSessionBackend,
  recordWebhookEvent,
  setSessionBackend,
  upsertSession,
  type AgentBackend,
  type WebhookEvent,
} from "./storage";
import { recordDataFields } from "./egress/store";
import { ANTHROPIC_BETA, resolveAnthropicBaseURL } from "./anthropic";
import { bytesToBase64 } from "./helpers";

const TOLERANCE_SECONDS = 300;
// Cap on the number of work items pulled from `work.poll` in a single
// drain pass. Sized to be larger than any realistic burst of webhooks
// that arrive between cron ticks while still keeping the Worker's
// per-request CPU budget intact. If the queue genuinely runs deeper
// than 25 in one tick, the next webhook (or the daily cron) picks
// the remainder up — drains are idempotent.
const MAX_DRAIN = 25;

export type { WebhookEvent } from "./storage";

export interface DrainResult {
  session_id: string;
  work_id: string;
  created: boolean;
}

function bearerClient(env: Env, token: string, what: string): Anthropic {
  if (!token) {
    throw new Error(`missing bearer token for ${what}`);
  }
  // apiKey: null prevents the SDK from backfilling `ANTHROPIC_API_KEY`
  // out of `process.env` (populated under `nodejs_compat`) and sending
  // both auth headers — the managed-agents server rejects that combo
  // with 401 on per-session endpoints.
  return new Anthropic({
    apiKey: null,
    authToken: token,
    baseURL: resolveAnthropicBaseURL(env),
  });
}

// Org-scoped endpoints (e.g. `beta.sessions.retrieve`) authenticate with the
// organization API key (`sk-ant-api...`) via the `x-api-key` header, NOT a
// Bearer token. Passing the org key to `bearerClient()` sends it as
// `Authorization: Bearer <key>`, which the per-session endpoints reject with
// 401. That 401 is swallowed by `resolveBackend`'s try/catch and silently
// forces every session onto the `microvm` fallback with `agent=(unknown)` —
// leaving Isolate routing and per-session egress policies dark. `authToken:
// null` keeps the SDK from also emitting an `Authorization` header alongside
// `x-api-key` (the server rejects the combined credentials).
function apiKeyClient(env: Env, token: string, what: string): Anthropic {
  if (!token) {
    throw new Error(`missing api key for ${what}`);
  }
  return new Anthropic({
    apiKey: token,
    authToken: null,
    baseURL: resolveAnthropicBaseURL(env),
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Standard Webhooks signature verification, per
// https://docs.standardwebhooks.com/verifying — Anthropic delivers webhooks
// using this format. Header shape:
//   webhook-id:        unique delivery id (also used in signed payload)
//   webhook-timestamp: unix seconds
//   webhook-signature: space-separated list of `v1,<base64-hmac-sha256>`
//                      values (one per active key version)
// The signed string is `${id}.${timestamp}.${rawBody}` HMAC-SHA256'd with
// the signing secret. Secrets may be passed as raw bytes or with a
// `whsec_<base64>` prefix.
async function verifyStandardWebhook(
  signatureHeader: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: ArrayBuffer,
  secret: string,
): Promise<boolean> {
  const ts = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  // Decode the secret. Standard Webhooks uses `whsec_<base64>` format; if
  // missing we treat the secret as raw bytes (UTF-8 encoded).
  let keyBytes: Uint8Array;
  if (secret.startsWith("whsec_")) {
    keyBytes = base64ToBytes(secret.slice("whsec_".length));
  } else {
    // Some users paste just the base64 portion; try base64 first, then fall
    // back to raw bytes.
    try {
      keyBytes = base64ToBytes(secret);
    } catch {
      keyBytes = new TextEncoder().encode(secret);
    }
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${webhookId}.${webhookTimestamp}.`);
  const body = new Uint8Array(rawBody);
  const signedInput = new Uint8Array(prefix.length + body.length);
  signedInput.set(prefix, 0);
  signedInput.set(body, prefix.length);

  const mac = await crypto.subtle.sign("HMAC", key, signedInput);
  const expected = bytesToBase64(new Uint8Array(mac));

  // Header may contain multiple signatures separated by spaces, e.g.
  // "v1,abc... v1,def...". Accept if any matches.
  for (const sig of signatureHeader.split(" ")) {
    const [ver, mac64] = sig.split(",", 2);
    if (ver !== "v1" || !mac64) continue;
    if (constantTimeEq(mac64, expected)) return true;
  }
  return false;
}

// Look up the per-agent backend for a session. Webhook + work payloads
// only include `session.id` (not `agent_id`), so on first sight we hit
// the API to resolve the agent and read the backend mapping from D1.
// We cache the `agent_id` per session (immutable — Anthropic binds one
// agent per session) so subsequent dispatches skip the round-trip, BUT
// we always re-read the backend from `agent_backends` because the user
// can change it from the dashboard mid-session. Caching the backend
// inline with the session row caused a nasty trap: a session whose
// first webhook arrived before the agent's backend row landed in D1
// (or whose agent's backend was flipped after the fact) was permanently
// pinned to the stale value. Defaults to "microvm" on any failure —
// worst case is we boot the legacy path for an Isolate-marked agent.
export async function resolveBackend(
  env: Env,
  sessionId: string,
): Promise<{ backend: AgentBackend; agentId: string | null }> {
  // Cache hit on agent_id: skip the Anthropic round-trip but ALWAYS
  // re-resolve the backend so a dashboard-driven backend switch (or a
  // race between agent create and first session webhook) takes effect.
  const cached = await getSessionBackend(env.DB, sessionId);
  if (cached.agentId) {
    const backend = await getAgentBackend(env.DB, cached.agentId);
    // If the previously-cached backend disagrees with the live mapping,
    // refresh the session row so the agents listing / sessions filter
    // queries stay accurate. Same UPDATE pattern as the first-sight
    // path; swallow errors so a write blip doesn't fail the webhook.
    if (cached.backend !== backend) {
      try {
        await setSessionBackend(env.DB, sessionId, cached.agentId, backend);
      } catch (error) {
        console.warn(
          `[webhook] failed to refresh cached backend for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { backend, agentId: cached.agentId };
  }
  try {
    const client = apiKeyClient(
      env,
      env.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY",
    );
    const session = await client.beta.sessions.retrieve(sessionId, {
      betas: [ANTHROPIC_BETA],
    });
    const agentId = session.agent?.id ?? null;
    const backend: AgentBackend = agentId
      ? await getAgentBackend(env.DB, agentId)
      : "microvm";
    // Cache the agent_id so we don't hit Anthropic again. Backend is
    // also written for the listing view (which still surfaces the
    // "backend" column), but `resolveBackend` will re-read agent_backends
    // on subsequent calls — don't trust this column as authoritative.
    try {
      await setSessionBackend(env.DB, sessionId, agentId, backend);
    } catch (error) {
      console.warn(
        `[webhook] failed to cache backend for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Auto-provision the agent's primary email alias on first sighting.
    // Idempotent (INSERT OR IGNORE), so the additional D1 round-trip is
    // only the cost of a missed cache. Skipped when EMAIL_DOMAIN isn't
    // configured — without it the alias has no domain to live on and
    // there's no email routing path to set up.
    if (agentId && env.EMAIL_DOMAIN) {
      try {
        await ensureAgentPrimaryEmail(env.DB, agentId);
      } catch (error) {
        console.warn(
          `[webhook] failed to provision email alias for agent=${agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { backend, agentId };
  } catch (error) {
    console.warn(
      `[webhook] failed to resolve backend for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { backend: "microvm", agentId: null };
  }
}

export async function drainWork(env: Env): Promise<DrainResult[]> {
  const baseURL = resolveAnthropicBaseURL(env);
  // Under the 0.96 SDK / ant 1.8 release the environment key is the single
  // credential for the whole worker flow — there is no per-work-item secret
  // any more, and `decodeWorkSecret` is gone. The poller returns just the
  // work item; the control plane authenticates every subsequent call (heartbeat,
  // force-stop, event stream) with the same env key the Worker holds.
  const poll = bearerClient(
    env,
    env.ANTHROPIC_ENVIRONMENT_KEY,
    "ANTHROPIC_ENVIRONMENT_KEY",
  );
  // Same fingerprint format as the IsolateRunner so a mismatch between the
  // poller's key and the per-session runner's key is obvious in logs.
  const ek = env.ANTHROPIC_ENVIRONMENT_KEY;
  console.log(
    `[webhook] env-key fingerprint env=${env.ENVIRONMENT_ID} len=${ek.length} prefix=${ek.slice(0, 16)} suffix=${ek.slice(-4)}`,
  );
  const spawned: DrainResult[] = [];

  for (let i = 0; i < MAX_DRAIN; i++) {
    const work = await poll.beta.environments.work.poll(env.ENVIRONMENT_ID, {
      reclaim_older_than_ms: 2000,
      betas: [ANTHROPIC_BETA],
    });

    if (!work) {
      break;
    }

    // `work.data` is now `Session | HealthCheck`; ignore non-session items.
    if (work.data.type !== "session") {
      continue;
    }

    const sessionId = work.data.id;
    console.log(`[webhook] work=${work.id} session=${sessionId}`);

    // Don't ack here. The control plane (MicroVM Sandbox container or the
    // SessionToolRunner in the IsolateRunner DO) sends its first heartbeat
    // with `expected_last_heartbeat=NO_HEARTBEAT`, which fails if we've
    // already acked from the worker. Let the control plane own the work.
    const { backend, agentId } = await resolveBackend(env, sessionId);
    console.log(
      `[webhook] backend=${backend} session=${sessionId} agent=${agentId ?? "(unknown)"}`,
    );

    if (backend === "isolate") {
      const runner = getIsolateRunner(env, sessionId);
      const wasLive = await runner.isLive();
      if (!wasLive) {
        await runner.start({
          sessionId,
          workId: work.id,
          environmentId: env.ENVIRONMENT_ID,
          baseURL,
          // Passed through so the control plane can audit the agent's tool list
          // and warn loudly if it's still on the broken Sandbox-toolset
          // shape. The agent id was resolved during the backend lookup.
          agentId,
        });
      }
      spawned.push({
        session_id: sessionId,
        work_id: work.id,
        created: !wasLive,
      });
      continue;
    }

    const stub = getSessionSandbox(env, sessionId);
    const wasLive = await stub.isLive();
    if (!wasLive) {
      await stub.dispatch({
        sessionId,
        workId: work.id,
        environmentId: env.ENVIRONMENT_ID,
        baseURL,
      });
    }

    spawned.push({
      session_id: sessionId,
      work_id: work.id,
      created: !wasLive,
    });
  }

  return spawned;
}

export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const cfRay = request.headers.get("cf-ray") || "unknown";
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !signature) {
    const headerNames = Array.from(request.headers.keys()).join(",");
    console.warn(
      `[webhook] rejected missing standard-webhooks headers cfRay=${cfRay} headers=${headerNames}`,
    );
    return Response.json({ error: "missing signature" }, { status: 401 });
  }

  const rawBody = await request.arrayBuffer();
  const valid = await verifyStandardWebhook(
    signature,
    webhookId,
    webhookTimestamp,
    rawBody,
    env.WEBHOOK_SECRET,
  );

  if (!valid) {
    console.warn(
      `[webhook] rejected invalid signature cfRay=${cfRay} webhookId=${webhookId} bytes=${rawBody.byteLength}`,
    );
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as WebhookEvent;
  } catch {
    console.warn(`[webhook] rejected invalid JSON cfRay=${cfRay}`);
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Defensive extraction — Anthropic test pings and unknown event types may
  // not have the strict { data: { type, id } } shape, and accessing
  // `event.data.type` on a malformed payload would throw before we ever hit
  // D1. The storage layer also coerces missing fields, but we mirror it here
  // so logs and the dispatch switch don't crash.
  const evData = (event && typeof event === "object" ? event.data : null) as
    | (Record<string, unknown> & { type?: unknown; id?: unknown })
    | null;
  const evType = typeof evData?.type === "string" ? evData.type : "unknown";
  const sessionId = typeof evData?.id === "string" ? evData.id : "";
  const eventId = typeof event?.id === "string" ? event.id : "(no-id)";
  const eventSummary = `id=${eventId} type=${evType} session=${sessionId || "(none)"}`;

  console.log(
    `[webhook] received ${eventSummary} ts=${event?.timestamp} cfRay=${cfRay} bytes=${rawBody.byteLength}`,
  );

  // Persist what we can — a single malformed event must never block future
  // events. We catch each side-effect independently and log loudly so we
  // can diagnose without rejecting the delivery (which would make Anthropic
  // retry indefinitely).
  try {
    await recordWebhookEvent(env.DB, event);
  } catch (error) {
    console.error(`[webhook] failed to record event ${eventSummary}`, error);
  }
  if (sessionId) {
    try {
      await upsertSession(env.DB, sessionId, evType, evData);
    } catch (error) {
      console.error(
        `[webhook] failed to upsert session ${eventSummary}`,
        error,
      );
    }
  }
  // Track which `data.*` field names we've seen so the policy editor can
  // suggest them in the matcher field input. Failures here are non-fatal.
  if (evData && typeof evData === "object") {
    try {
      await recordDataFields(env, Object.keys(evData));
    } catch (error) {
      console.warn(
        `[webhook] failed to record data fields ${eventSummary}`,
        error,
      );
    }
  }
  console.log(`[webhook] persisted ${eventSummary}`);

  switch (evType) {
    case "session.status_run_started": {
      try {
        console.log(`[webhook] action=drainWork ${eventSummary}`);
        const spawned = await drainWork(env);
        console.log(
          `[webhook] action=drainWork complete ${eventSummary} spawned=${spawned.length}`,
        );
        return Response.json({ status: "ok", spawned });
      } catch (error) {
        console.error(
          `[webhook] action=drainWork failed ${eventSummary}`,
          error,
        );
        // Already persisted above — return 200 so Anthropic doesn't retry.
        return Response.json({ status: "ok", drainError: true });
      }
    }
    case "session.status_terminated":
    case "session.status_idled": {
      // Capture /workspace to R2 now rather than waiting for the base
      // Container class's idle alarm to fire. The alarm is the backstop
      // (snapshots then stops the container after SESSION_IDLE_TTL of
      // inactivity), but if the platform reclaims the MicroVM before then
      // — deploy, eviction, crash — the snapshot would be lost. Doing it
      // on the webhook gives us a guarantee that "session ended" implies
      // "files are durable in R2", independent of container lifecycle.
      //
      // We don't destroy() the container here. A terminated session may
      // come back via session.status_run_started on the same id, and a
      // warm container is faster than a cold boot + restore. The idle
      // alarm will reap it shortly anyway.
      //
      // Isolate sessions persist their workspace via DO SQLite, so the
      // snapshot path is microvm-only.
      if (sessionId) {
        try {
          const { backend } = await resolveBackend(env, sessionId);
          if (backend === "microvm") {
            const stub = getSessionSandbox(env, sessionId);
            if (await stub.isLive()) {
              console.log(`[webhook] action=snapshot ${eventSummary}`);
              await stub.snapshot();
            } else {
              console.log(
                `[webhook] action=snapshot-skipped ${eventSummary} reason=container-not-live`,
              );
            }
          } else {
            console.log(
              `[webhook] action=snapshot-skipped ${eventSummary} backend=isolate`,
            );
          }
        } catch (error) {
          // Best-effort: a snapshot failure must never make Anthropic
          // retry the terminate webhook. We've already persisted the
          // event above; log and move on.
          console.warn(
            `[webhook] snapshot-on-terminate failed ${eventSummary}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      console.log(
        `[webhook] action=keep-container ${eventSummary} sleepAfter=${SESSION_IDLE_TTL}`,
      );
      break;
    }
    default: {
      console.log(`[webhook] action=ignored ${eventSummary}`);
      break;
    }
  }

  return new Response(null, { status: 204 });
}
