import { describe, expect, it } from "vitest";
import { fingerprintPolicy } from "../src/isolate/policy-fingerprint";
import type { CompiledPolicy } from "../src/egress/types";

const policyTemplate = (
  overrides: Partial<CompiledPolicy> = {},
): CompiledPolicy => ({
  policyId: "pol_test",
  policyName: "test",
  allow: ["api.example.com"],
  deny: ["blocked.example.com"],
  headerInjections: [],
  proxy: null,
  vpcRoutes: [],
  ...overrides,
});

describe("fingerprintPolicy", () => {
  it("does not expose header-injection secret values", async () => {
    const fingerprint = await fingerprintPolicy(
      policyTemplate({
        headerInjections: [
          {
            target: "api.example.com",
            header: "authorization",
            secretValue: "sk-live-secret-value",
          },
        ],
      }),
    );

    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("sk-live-secret-value");
  });

  it("changes when a header-injection secret rotates", async () => {
    const before = await fingerprintPolicy(
      policyTemplate({
        headerInjections: [
          {
            target: "api.example.com",
            header: "authorization",
            secretValue: "old-secret",
          },
        ],
      }),
    );
    const after = await fingerprintPolicy(
      policyTemplate({
        headerInjections: [
          {
            target: "api.example.com",
            header: "authorization",
            secretValue: "new-secret",
          },
        ],
      }),
    );

    expect(after).not.toBe(before);
  });

  it("does not expose proxy code or proxy secret values", async () => {
    const fingerprint = await fingerprintPolicy(
      policyTemplate({
        proxy: {
          policyId: "pol_test",
          code: "async function fetch() { return fetch('https://internal.example'); }",
          secrets: {
            AUTHORIZATION: "proxy-secret",
          },
        },
      }),
    );

    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("internal.example");
    expect(fingerprint).not.toContain("proxy-secret");
  });
});
