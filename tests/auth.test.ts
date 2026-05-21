import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEnv, type FakeEnv } from "./helpers";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
}));

vi.mock("../src/microvm/sandbox", () => ({
  Sandbox: class {},
  getSessionSandbox: () => ({
    ensureStarted: async () => {},
    terminal: async () => new Response("terminal"),
  }),
}));

vi.mock("../src/isolate/runner", () => ({
  IsolateRunner: class {},
}));

vi.mock("../src/isolate/gateway", () => ({
  IsolateOutboundGateway: class {},
}));

vi.mock("../src/webhooks", () => ({
  handleWebhook: async () => new Response(null, { status: 204 }),
  resolveBackend: async () => ({ backend: "microvm", agentId: null }),
  drainWork: async () => [],
}));

import worker from "../src/index";

function ctx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

async function accessEnv(): Promise<{ env: FakeEnv; token: string }> {
  const teamDomain = `${crypto.randomUUID()}.cloudflareaccess.com`;
  const audience = `aud-${crypto.randomUUID()}`;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    ),
  );

  const token = await new SignJWT({ email: "operator@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://${teamDomain}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  return {
    env: makeEnv({
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: audience,
    }),
    token,
  };
}

function callWorker(env: FakeEnv, path: string, init?: RequestInit) {
  return worker.fetch(
    new Request(`https://example.com${path}`, init),
    env as unknown as Env,
    ctx(),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard authentication", () => {
  it("runs the Worker before static assets so dashboard files are auth-gated", () => {
    const wrangler = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );

    expect(wrangler).toMatch(/"run_worker_first"\s*:\s*true/);
  });

  it("applies Access auth before falling back to static assets", async () => {
    const res = await callWorker(makeEnv(), "/");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("CF_ACCESS_TEAM_DOMAIN"),
    });
  });

  it("fails closed when Cloudflare Access is not configured", async () => {
    const res = await callWorker(makeEnv(), "/api/config");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("CF_ACCESS_TEAM_DOMAIN"),
    });
  });

  it("rejects protected routes without an Access JWT", async () => {
    const { env } = await accessEnv();
    const res = await callWorker(env, "/api/config");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "missing Cloudflare Access JWT",
    });
  });

  it("rejects protected routes with an invalid Access JWT", async () => {
    const { env } = await accessEnv();
    const res = await callWorker(env, "/api/config", {
      headers: { "cf-access-jwt-assertion": "not-a-jwt" },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "invalid Cloudflare Access JWT",
    });
  });

  it("allows protected routes with a valid Access JWT", async () => {
    const { env, token } = await accessEnv();
    const res = await callWorker(env, "/api/config", {
      headers: { "cf-access-jwt-assertion": token },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      environmentId: "env_test",
      missing: [],
    });
  });

  it("keeps webhooks on the HMAC-authenticated bypass path", async () => {
    const res = await callWorker(makeEnv(), "/webhooks", { method: "POST" });

    expect(res.status).toBe(204);
  });
});
