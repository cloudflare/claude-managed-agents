import type { CompiledPolicy } from "../egress/types";

const NO_POLICY_FINGERPRINT = "(none)";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashRecordValues(
  values: Record<string, string>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([key, value]) => [key, await sha256Hex(value)] as const),
  );
  return Object.fromEntries(entries);
}

// Stable, non-reversible fingerprint of a compiled policy. It includes every
// field that affects outbound behavior, but hashes secret material and proxy
// code before hashing the whole canonical structure so drift logs/state never
// contain raw credentials or user code.
export async function fingerprintPolicy(
  policy: CompiledPolicy | null,
): Promise<string> {
  if (!policy) return NO_POLICY_FINGERPRINT;

  const headerInjections = await Promise.all(
    [...policy.headerInjections]
      .sort((a, b) => (a.header + a.target).localeCompare(b.header + b.target))
      .map(async (h) => ({
        target: h.target,
        header: h.header,
        secretSha256: await sha256Hex(h.secretValue),
      })),
  );

  const canonical = {
    id: policy.policyId,
    name: policy.policyName,
    allow: [...policy.allow].sort(),
    deny: [...policy.deny].sort(),
    headerInjections,
    vpcRoutes: [...policy.vpcRoutes].sort((a, b) =>
      (a.host + a.binding).localeCompare(b.host + b.binding),
    ),
    proxy: policy.proxy
      ? {
          policyId: policy.proxy.policyId,
          codeSha256: await sha256Hex(policy.proxy.code),
          secretsSha256: await hashRecordValues(policy.proxy.secrets),
        }
      : null,
  };

  return `sha256:${await sha256Hex(JSON.stringify(canonical))}`;
}
