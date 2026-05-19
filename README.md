# Claude Managed Agents on Cloudflare

Run Claude Managed Agents (CMA) on Cloudflare.

This repo provides a customizable control plane that allows you to:
- Run CMA sandboxes on both full containers and light-weight isolates
- Customize the container size and image your agents use
- Get better observability into agent sandboxes
- Apply custom egress controls for [zero-trust credential injection](https://blog.cloudflare.com/sandbox-auth/) and connectivity to private services over [Workers VPC](https://developers.cloudflare.com/workers-vpc/)
- Extend your Agents with [Browser Run](https://developers.cloudflare.com/browser-run), [Email](https://developers.cloudflare.com/email-service/), and any other custom tools using the [Cloudflare Developer Platform](https://workers.cloudflare.com/products#all)
 your needs.

Follow the [Onboarding Guide](#onboarding-guide) to get started.

> **You need a Paid or Enterprise Cloudflare account to run Managed Agents.**
> [Cloudflare Containers](https://developers.cloudflare.com/containers/)
> (used by the MicroVM sandbox) and Worker Loader bindings (used by the
> Isolate sandbox's code-execution and egress proxy tools) are **Workers
> Paid plan and above**.

## Overview

This repository deploys a Workers-based control plane for running Claude Managed Agents on Cloudflare.

Claude Managed Agents will send a webhook to your Worker when an agent session begin or ends. The
control plane spins up a sandbox for each session, syncs state across session sleeps, and shuts down
the sandbox when the session ends.

Sandboxes can be [Cloudflare Containers](https://developers.cloudflare.com/containers/) or [Isolate](https://developers.cloudflare.com/dynamic-workers/) sandboxes using the [AgentsSDK](https://developers.cloudflare.com/agents/). This
allows you to get either the full functionality of a Linux VM or a lightweight isolate
that can hit massive scales without the resource overhead or cost of a microVM.

You can configure policies to restrict agent access to specific domains, inject credentials into outgoing
requests without the agent ever accessing secrets, or write arbitrary proxy code to modify, reroute,
or log egress traffic.

Additionally, you can connect [Workers VPC](https://developers.cloudflare.com/workers-vpc/) and [Mesh](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/) resources to your sandboxes. This allows you
to easily access private resources, on any cloud or on-prem, without them ever being exposed to the public internet.

Lastly, this codebase can be easily extended to add custom tools to your agent's sandbox. Tools are picked up
automatically by both backends and run with direct access to Worker bindings so they can take advantage of
the whole Cloudflare Developer Platform.

The repo provides built-in tools for:
- Email Sending
- Private Service Access
- Browser Automation
- Image Generation

All of this is accessible via a UI and API that gets deployed to your Cloudflare account.

With the repository you should be able to get a Cloudflare-based self-managed environment up and
running quickly. Then you can fork it, customize it to suit your needs, and redeploy. This repository is
meant as a starting point.

## Onboarding guide

Note: order matters

**1. Initial deploy.**

```sh
npm run deploy
```

This builds your base sandbox container image (Docker required) and deploys the Worker.
Wrangler auto-provisions the D1 database, KV namespaces, and R2 bucket declared
in `wrangler.jsonc` on first deploy (requires wrangler 4.45+; see
[auto-provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning),
currently open beta). The worker won't function until you finish the
remaining steps, but the deploy gives you the
`https://<your-worker>.workers.dev` URL you'll need for the webhook.

**2. Create an Anthropic environment and webhook.** Create a
"Self-managed" environment in the
[Claude Platform Console](https://platform.claude.com/workspaces/default/environments)
and save the environment secret key. Then, in the
[Webhooks settings](https://platform.claude.com/settings/workspaces/default/webhooks),
set the webhook URL to `https://<your-worker>.workers.dev/webhooks`
and save the generated Webhook Secret.

You will need the following values:

- `ENVIRONMENT_ID` — the ID of your new self-managed environment
- `ANTHROPIC_ENVIRONMENT_KEY` — environment secret key used by the control plane to
  authenticate calls from the specified Claude agent environment
- `ANTHROPIC_API_KEY` — used by the Worker to make calls to Anthropic
- `WEBHOOK_SECRET` — Standard Webhooks signing secret. Anthropic posts
  events to your Worker; we verify the signature before doing anything
  with them.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` — Cloudflare Access
  settings used by the Worker to validate the `Cf-Access-Jwt-Assertion`
  header before serving the dashboard, `/api/*`, `/openapi.json`, static
  assets, or `/ws/terminal`. `/webhooks` remains HMAC-authenticated by
  `WEBHOOK_SECRET`.

**3. Set the secrets.**

Locally:

```sh
cp .dev.vars.example .dev.vars
```

Fill in the values above in `.dev.vars`.

In production:

```sh
npx wrangler secret put ANTHROPIC_ENVIRONMENT_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ENVIRONMENT_ID
npx wrangler secret put WEBHOOK_SECRET
```

Set the Access values as non-secret vars in `wrangler.jsonc` before deploy:

```jsonc
"vars": {
  "CF_ACCESS_TEAM_DOMAIN": "<your-team>.cloudflareaccess.com",
  "CF_ACCESS_AUD": "<your-access-application-aud-tag>"
}
```

**4. Apply D1 migrations.** The database was auto-created in step 1
but is empty.

For production:

```sh
npm run db:migrate:remote   # production
```

For local dev:

```sh
npm run db:migrate          # local
```

**5. Provision R2 snapshot credentials.**

The R2 bucket itself was auto-created in step 1. The presigned-URL path
used in production still needs an access key.

This is required unless you're exclusively using Isolate sandboxes
or running stateless agent sessions. Isolate sessions persist through
Durable Object SQLite storage and don't need R2 — if you're certain
you'll never run a MicroVM agent, you can skip this step (and drop the
`r2_buckets` block from `wrangler.jsonc`).

Anyone running the MicroVM backend should treat this as core onboarding.

[Mint an R2 access key](https://dash.cloudflare.com/r2/api-tokens/create?type=user)
with read+write on the `claude-managed-agents-snapshots` bucket
(Cloudflare dashboard → R2 → Manage R2 API Tokens → Create token),
copy the Access Key ID and Secret Access Key, then push the following secrets:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put BACKUP_BUCKET_NAME # same as bucket_name in wrangler.jsonc (IE: claude-managed-agents-snapshots)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID # found in your dashboard URL
```

See [Snapshots & state persistence](./docs/snapshots-and-state-persistence.md)
for more information.

**6. (Optional) Turn on the extras.** Each is opt-in; skip what you don't need.

| Capability | Bindings to add | Secrets to add | Setup steps |
|---|---|---|---|
| Browser Rendering tools | uncomment `browser` in `wrangler.jsonc` | `CLOUDFLARE_API_TOKEN` (for REST tools) | none |
| Workers AI image gen | uncomment `ai` in `wrangler.jsonc` | none | None |
| Email send + inbox | uncomment `send_email` in `wrangler.jsonc`; set `EMAIL_DOMAIN` + `EMAIL_FROM` (Deploy to Cloudflare prompts for these, or `vars` in `wrangler.jsonc` locally) | none | [Email docs](./docs/agent-email.md) |
| VPC private services | add `vpc_services` blocks in `wrangler.jsonc` | none | [Workers VPC docs](./docs/connecting-to-private-services.md) |

**7. Visit the dashboard.** `https://<your-worker>.workers.dev/`. Create an
agent (the form lets you pick MicroVM or Isolate backend), kick off a
session, watch the logs.

**8. Secure the Dashboard** The Worker validates Cloudflare Access JWTs
server-side, so keep the dashboard behind a Cloudflare Access
self-hosted application and configure `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD`. Requests without a valid Access JWT fail closed.

See [Cloudflare Access docs](./docs/securing-access.md) for more information.

**9. Customize the control plane (optional)** Fork this repo
and customize it to suit your needs or add custom tools.

## Going deeper

Once the control plane is up and a first session has run end-to-end,
you can go futher:

- [Connect to Private Services](./docs/connecting-to-private-services.md)
  in other clouds or on-prem (or even on your laptop) with Workers VPC bindings.
- [Inject credentials and lock down agent sessions](./docs/applying-egress-policies.md)
  with egress policies. Set up allow/deny lists, header-injection, custom Worker proxies,
  and VPC routing.
- [Pick between Isolate and VM-based Sandboxes](./docs/isolate-vs-vm-sandboxes.md)
  for the best agent execution environment.
- [Set up Agent Email](./docs/agent-email.md) to give your
  new agents email addresses and sending abilities.
- [Use Browser Run](./docs/browser-rendering-tools.md) to get
  powerful and observable and agent browser interactions.
- [Add Custom Tools](./docs/adding-custom-tools.md) New tools are declared in a single
  file — [`src/tools/custom-tools.ts`](./src/tools/custom-tools.ts).
- [Customize your Sandboxes](./docs/customizing-sandboxes.md) by changing
  `Dockerfile` and `instance_type` knobs for the MicroVM backend.
- [Learn about state persistence](./docs/snapshots-and-state-persistence.md)
  across both sandbox types.
- [Explore the Architecture](./docs/architecture.md) to learn about the request lifecycle
  from webhook ingress through dispatch to either sandbox backend, and
  inventories every Worker binding the control plane uses.
- [Secure Access](./docs/securing-access.md) to your the new CMA control plane.

## Configuration reference

Required secrets & vars:

| Name | Description |
|---|---|
| `ENVIRONMENT_ID` | Environment to poll for work |
| `ANTHROPIC_ENVIRONMENT_KEY` | Anthropic environment key (sk-ant-oat01-...). The single credential the control plane uses for poll, ack, heartbeat, force-stop, and the session event stream. Renamed from `ANTHROPIC_ENV_KEY` in the 0.96 SDK / ant 1.8 CLI. |
| `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) |
| `WEBHOOK_SECRET` | HMAC secret for verifying webhook signatures |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain, for example `<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Cloudflare Access Application Audience (AUD) tag for the protected dashboard/API app |
| `CLOUDFLARE_ACCOUNT_ID` | R2 snapshots (presigned URL mode); also used by Browser Rendering REST tools |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 snapshots (presigned URL mode) |
| `BACKUP_BUCKET_NAME` | R2 snapshots (presigned URL mode) |

The snapshot-related values are required for production deploys that run
MicroVM sandboxes. `wrangler dev` can run without them by falling back
to the BACKUP_BUCKET binding directly, but the R2 bucket itself must
exist (done in initial deploy). Deployments that exclusively use Isolate
sandboxes can drop the snapshot secrets and the `r2_buckets` block
entirely.

Optional secrets:

| Name | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Browser Rendering REST tools |
| `ANTHROPIC_BASE_URL` | Override (defaults to `https://api.anthropic.com`) |

Optional vars:

| Name | Used for |
|---|---|
| `EMAIL_DOMAIN` | Suffix for per-session inbox addresses |
| `EMAIL_FROM` | Default sender for `cf_email_send` |
| `EMAIL_FORWARD` | Fallback inbox for stray (non-session) email |

Optional bindings (declare in `wrangler.jsonc`):

| Binding | Used for |
|---|---|
| `BROWSER` | Isolate CDP browser tools |
| `AI` | `cf_image_generate` |
| `BACKUP_BUCKET` | Sandbox snapshots |
| `SEND_EMAIL` | `cf_email_send` |
| `vpc_services[]` | Private VPC service routing + `cf_call_service` |

## Tests

```sh
npm test
```

Vitest covers the egress proxy, storage layer, and API surface. VPC and
Mesh test stubs are included but commented out — see the `describe.skip(...)`
blocks at the bottom of `tests/egress.test.ts` for the planned shape.

## License

[MIT](./LICENSE)
