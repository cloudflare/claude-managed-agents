# Securing Access

The dashboard is protected by Cloudflare Access JWT validation in the
Worker. Requests to `/`, `/api/*`, `/openapi.json`, static assets, and
`/ws/terminal` fail closed unless the Worker can validate the
`Cf-Access-Jwt-Assertion` header against your Access application's AUD
tag. `/webhooks` is the intentional bypass because Anthropic calls it
directly; that route uses the Standard Webhooks signature check instead.

Put the Worker behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/),
then configure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. Custom tool
calls don't traverse a public Worker endpoint — the Sandbox /
IsolateRunner Durable Object pulls them straight from Anthropic's
session event stream and dispatches them in-DO against the Worker's
bindings — so there's no public tool surface to protect beyond the
dashboard itself. The existing server-side checks (Access JWT
validation, Standard Webhooks signature, input validation) act as
defence in depth.

## What you can do

- **Gate the dashboard** behind your IdP — Google, GitHub, Okta, OTP,
  whatever Access supports. Users see your normal SSO flow before they
  ever reach the agent UI, and the Worker verifies the Access JWT that
  reaches it.
- **Restrict who can create or run sessions.** Access policies can
  include / exclude by group, email, IP range, or service token.
- **Issue service tokens** for CI / scripts so deploys and external
  calls into `/api/*` don't break.
- **Keep webhooks reachable.** Anthropic and Cloudflare Email Routing
  both call your Worker without an Access JWT, so those paths get a
  Bypass policy and rely on the existing server-side auth.

## Why use it

- **No app-owned login flow.** Access does the SSO, MFA, and policy work
  outside the Worker. The Worker only validates the signed Access JWT, so
  you don't carry your own session store, login UI, or password reset
  flow.
- **No secrets shared with browsers.** The dashboard's API calls go
  through Access, which adds a signed JWT for the Worker to validate.
- **Granular per-user policy.** Different agents for different teams,
  different environments for different on-call rotations.
- **Audit log out of the box.** Access logs every authenticated
  request to your tenant — useful when a session does something
  surprising and you want to know who launched it.

## Setting it up

### 1. Create a Self-hosted Access application

In **Zero Trust → Access → Applications**, add a Self-hosted
application:

- **Application domain** — your Worker's route, e.g.
  `agents.example.com`.
- **Session duration** — whatever your security model requires.
- **Identity providers** — pick the ones you want; add an OTP fallback
  if you don't have an IdP integrated.
- **Policies** — at least one Allow policy for the people you want
  in. Add Service Tokens here too if you'll script anything.

Copy these values into your Worker vars:

- `CF_ACCESS_TEAM_DOMAIN` — your Access team domain, for example
  `<team>.cloudflareaccess.com`.
- `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access
  application.

If either value is missing, the dashboard/API/terminal routes return
`503` instead of serving open.

### 2. Bypass the webhook path

Anthropic posts to `/webhooks` without an Access JWT — there's no way
to attach one. Add a **Bypass** policy under the same application
covering:

- `/webhooks` — Anthropic webhook ingress. The Standard Webhooks
  signature check (`WEBHOOK_SECRET`) is the auth here.

The `email()` Worker entrypoint isn't HTTP, so Access doesn't see it
and no policy is needed.

Custom-tool calls don't need an Access bypass — they flow Anthropic →
Sandbox / IsolateRunner DO directly via the Anthropic session event
stream. Tools execute inside the Worker's Durable Object with `env`
access; nothing reaches the public Worker hostname.

### 3. (Recommended) Service tokens for CI

If you want to script deploys, drains, or policy edits from CI, mint
an Access service token and add it as an Include rule on the
application's policy. Then in the script:

```sh
curl https://agents.example.com/api/egress-policies \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

### 4. Lock down the dashboard's outbound surface

The dashboard talks to `/api/*` from the user's browser, so the same
Access policy that protects `/` also protects the API. The Worker also
validates the Access JWT on those requests before dispatching them.

## What's already authenticated server-side

The Worker doesn't trust headers blindly:

**Access JWTs.** `src/auth.ts` validates `Cf-Access-Jwt-Assertion`
against your Access team's JWKS endpoint, issuer, and application AUD
before serving the dashboard, `/api/*`, `/openapi.json`, static assets,
or `/ws/terminal`.

**Webhook signatures.** `src/webhooks.ts` verifies every webhook with
HMAC-SHA256:

```
HMAC-SHA256(
  "${webhook-id}.${webhook-timestamp}.${rawBody}",
  WEBHOOK_SECRET
)
```

±300s tolerance, constant-time comparison, supports both
`whsec_<base64>` and raw-byte secrets. Bad signature → 401, no
side-effects.

**Input validation.** Every API route asserts a tight regex on ids
before touching D1 or KV:

```ts
// src/helpers.ts
const SESSION_ID_REGEX = /^(?:session|sesn)_[^/]+$/;
const AGENT_ID_REGEX   = /^agent_[^/]+$/;
const SECRET_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const POLICY_ID_REGEX  = /^pol_[A-Za-z0-9._-]{1,64}$/;
```

**Environment key.** `ANTHROPIC_ENVIRONMENT_KEY` authenticates every
call the control plane makes (poll, ack, heartbeat, force-stop, the
per-session event stream, skill download). The Worker holds it as a
secret and forwards it into MicroVM sandboxes so `ant beta:worker run`
can authenticate; Isolate sandboxes use it in-Worker so the key never
leaves the control plane process.

## Server-side tools run off your account

`web_fetch` and `web_search` execute on Anthropic's infrastructure, not
in your sandbox or on your Cloudflare account. You have no visibility
into them — no Workers Logs entry, no Logpush record, no audit trail.
Your egress policy doesn't apply either. The agent form turns them off
by default and surfaces a warning before you opt in.

If you need an HTTP fetch you can audit, prefer the `cf_*` alternatives
(`cf_web_fetch`, `browse`, `fetch_to_markdown`). They run on your
Cloudflare account through Browser Rendering, so every request shows up
in Workers Logs / Logpush / the BR dashboard. They do not, however,
traverse the per-session egress policy — that policy only wraps fetches
issued from inside the sandbox itself (the container on MicroVM, the
`execute` / `run_file` dynamic Worker on Isolate).

## Threat model checklist

- [ ] **Set `WEBHOOK_SECRET`** to a strong value (`openssl rand -hex
      32`). Without it the Worker rejects all webhooks, but the
      verification is meaningful only when the secret has entropy.
- [ ] **Put the dashboard behind Cloudflare Access** and configure
      `CF_ACCESS_TEAM_DOMAIN` plus `CF_ACCESS_AUD`; without them the
      dashboard/API/terminal fail closed.
- [ ] **Bypass `/webhooks`** in Access; let the Standard Webhooks
      signature check handle it.
- [ ] **Audit egress policies.** Default-deny is safer than
      default-allow. See [Applying Egress Policies](./applying-egress-policies.md).
- [ ] **Limit who can edit secrets and policies.** The dashboard's
      Secrets and Egress Policies pages are powerful — anyone who can
      reach them can rewrite traffic for every session.
- [ ] **Rotate `ANTHROPIC_API_KEY`** on the schedule your security
      team requires. `wrangler secret put ANTHROPIC_API_KEY` swaps it
      with no downtime.

## Where to look

- Webhook signature verification: `src/webhooks.ts` (`verifyStandardWebhook`)
- Access JWT validation: `src/auth.ts` (`requireDashboardAuth`)
- API id regexes: `src/helpers.ts`
- Custom-tool dispatchers: `src/microvm/sandbox.ts` and
  `src/isolate/runner.ts` both call `runCustomToolDispatcher` from
  `src/isolate/custom-dispatch.ts`
