import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const accessJwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function normalizeAccessTeamDomain(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  return withoutProtocol.replace(/\/+$/g, "");
}

function getAccessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = accessJwksByTeamDomain.get(teamDomain);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  accessJwksByTeamDomain.set(teamDomain, jwks);
  return jwks;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
  options: Pick<JWTVerifyOptions, "currentDate"> = {},
): Promise<void> {
  await jwtVerify(token, getAccessJwks(teamDomain), {
    issuer: `https://${teamDomain}`,
    audience,
    ...options,
  });
}

export async function requireDashboardAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const teamDomain = normalizeAccessTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = env.CF_ACCESS_AUD?.trim();

  if (!teamDomain || !audience) {
    return jsonError(
      "dashboard authentication is not configured: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD",
      503,
    );
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) {
    return jsonError("missing Cloudflare Access JWT", 401);
  }

  try {
    await verifyCloudflareAccessJwt(token, teamDomain, audience);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auth] Cloudflare Access JWT rejected: ${message}`);
    return jsonError("invalid Cloudflare Access JWT", 403);
  }

  return null;
}
