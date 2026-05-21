# Claude Managed Agents on Cloudflare

Run Claude Managed Agents (CMA) on Cloudflare.

This repo provides a customizable control plane that allows you to:
- Run CMA sandboxes on both full containers and light-weight isolates
- Customize the container size and image your agents use
- Get better observability into agent sandboxes
- Apply custom egress controls for [zero-trust credential injection](https://blog.cloudflare.com/sandbox-auth/) and connectivity to private services over [Workers VPC](https://developers.cloudflare.com/workers-vpc/)
- Extend your Agents with [Browser Run](https://developers.cloudflare.com/browser-run), [Email](https://developers.cloudflare.com/email-service/), and any other custom tools using the [Cloudflare Developer Platform](https://workers.cloudflare.com/products#all)
 your needs.

Follow the [Onboarding Guide](#onboarding-guide) to get started. Two
deployment styles are supported: a one-click Deploy to Cloudflare
button (git-based, runs in Workers Builds) and a terminal-based
`npm run deploy` flow from your laptop.

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

Order matters — work through the steps top to bottom.

### Pick a deployment style
There are two ways to deploy. Pick one and stick with it for the whole onboarding:

- **Git-based**. Click the [Deploy to Cloudflare](#step-1-initial-deploy) button.
  Cloudflare forks this repo into your GitHub account, deploys your control plane
  and then future pushes to this GitHub repo will deploy updates automatically.
- **Terminal-based**. Run `npm run deploy` from your laptop. Requires
  Docker (for the container image build) and a `wrangler login`
  session.

**Steps 1 and 3 differ between the two tracks** — each has separate
sub-sections below. Steps 2 and 4 through 9 are identical regardless
of how you deployed.

---

### Step 1. Initial deploy

#### Git-based

The Deploy to Cloudflare button forks this repo into your GitHub account,
provisions the D1 database, KV namespaces, R2 bucket, and Durable Objects
automatically, prompts you for the required secrets (see Step 2), and
deploys the Worker via Workers Builds.

After the deploy finishes you'll have a `https://<your-worker>.workers.dev`
URL you'll need in step 2.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/claude-managed-agents)

> ⚠️ **You must rename one of the two KV namespaces in the deploy
> form.** The "Configure resources" step pre-fills both `SECRETS`
> and `EGRESS_POLICIES` with the same default name, and the deploy
> will fail with `Cannot provision a KV Namespace ... because it
> already exists` if you don't change one. Suggested names:
> `<worker-name>-secrets` and `<worker-name>-egress-policies`.

The worker won't function until you finish the remaining steps.

#### Terminal-based

```sh
npm run deploy
```

`npm run deploy` builds your base sandbox container image (Docker
required), deploys the Worker, and applies D1 migrations via the
`postdeploy` hook. The committed `wrangler.jsonc` deliberately leaves
KV `id` fields and the D1 `database_id` empty — `scripts/ensure-kv.mjs`
and `scripts/ensure-d1.mjs` run on `prebuild` and patch the real IDs
in (adopting any namespaces / databases that already exist by name,
creating fresh ones otherwise). R2 buckets are bound by name (no ID
lookup needed) and are auto-created by wrangler.

If you're on a Cloudflare login that has access to more than one
account, set `CLOUDFLARE_ACCOUNT_ID` before running so the ensure
scripts know which account to talk to:

```sh
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npm run deploy
```

The worker won't function until you finish the remaining steps, but
the deploy gives you the `https://<your-worker>.workers.dev` URL
you'll need for the webhook.

---

### Step 2. Create an Anthropic environment and webhook

Create a "Self-managed" environment in the
[Claude Platform Console](https://platform.claude.com/workspaces/default/environments)
and save the environment secret key. Then, in the
[Webhooks settings](https://platform.claude.com/settings/workspaces/default/webhooks),
set the webhook URL to `https://<your-worker>.workers.dev/webhooks`
and save the generated Webhook Secret.

You will need the following values:

- `ENVIRONMENT_ID` — the ID of your new self-managed environment
- `ANTHROPIC_ENVIRONMENT_KEY` — environment secret key used by the
  control plane to authenticate calls from the specified Claude agent
  environment
- `ANTHROPIC_API_KEY` — used by the Worker to make calls to Anthropic
- `WEBHOOK_SECRET` — Standard Webhooks signing secret. Anthropic posts
  events to your Worker; we verify the signature before doing anything
  with them.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` — Cloudflare Access
  settings used by the Worker to validate the `Cf-Access-Jwt-Assertion`
  header before serving the dashboard, `/api/*`, `/openapi.json`, static
  assets, or `/ws/terminal`. `/webhooks` remains HMAC-authenticated by
  `WEBHOOK_SECRET`.

---

### Step 3. Set the secrets

#### Git-based

The Deploy to Cloudflare form prompted for the core secrets when you
deployed, so `ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY`, and
`ANTHROPIC_API_KEY` are already on your Worker. If not,
add them with `npx wrangler secret put` as well.

Two follow-ups:

1. **Re-add `WEBHOOK_SECRET`.** The webhook didn't exist yet when
   you deployed (you created it in step 2), so whatever placeholder
   you supplied in the form is wrong. Push the real value now:

   ```sh
   npx wrangler secret put WEBHOOK_SECRET
   ```

2. **Copy the secret values into `.dev.vars` for local development.**
   Workers Builds doesn't sync your form inputs back to the repo, so
   `wrangler dev` won't see them otherwise.

   ```sh
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars and paste the values you supplied in the form,
   # plus the real WEBHOOK_SECRET from step 2.
   ```

#### Terminal-based

Set up local dev:

```sh
cp .dev.vars.example .dev.vars
# Edit with your real values
```

In production, every entry in `.dev.vars` needs a matching
`wrangler secret put NAME`. The four core secrets are:

```sh
npx wrangler secret put ENVIRONMENT_ID
npx wrangler secret put ANTHROPIC_ENVIRONMENT_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SECRET
```

Set the Access values as non-secret vars in `wrangler.jsonc` before deploy:

```jsonc
"vars": {
  "CF_ACCESS_TEAM_DOMAIN": "<your-team>.cloudflareaccess.com",
  "CF_ACCESS_AUD": "<your-access-application-aud-tag>"
}
```

---

### Step 4. Apply D1 migrations

The `postdeploy` hook runs `wrangler d1 migrations apply DB --remote`
automatically after every `npm run deploy` (including the Deploy to
Cloudflare button's deploy), so there's nothing to do here for
production. For local dev:

```sh
npm run db:migrate          # local
```

---

### Step 5. Provision R2 snapshot credentials

The R2 bucket itself was auto-created in step 1. The presigned-URL
path used in production still needs an access key. If you provided
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `BACKUP_BUCKET_NAME` /
`CLOUDFLARE_ACCOUNT_ID` during the Deploy to Cloudflare form, you
can skip ahead — they're already set.

This is required unless you're exclusively using Isolate sandboxes
or running stateless agent sessions. Isolate sessions persist through
Durable Object SQLite storage and don't need R2 — if you're certain
you'll never run a MicroVM agent, you can skip this step (and drop
the `r2_buckets` block from `wrangler.jsonc`).

Anyone running the MicroVM backend should treat this as core
onboarding.

[Mint an R2 access key](https://dash.cloudflare.com?to=/:account/r2/api-tokens/create?type=user)
with read+write on the `claude-managed-agents-snapshots` bucket
(Cloudflare dashboard → R2 → Manage R2 API Tokens → Create token),
copy the Access Key ID and Secret Access Key, then push the
following secrets:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put BACKUP_BUCKET_NAME # same as bucket_name in wrangler.jsonc (IE: claude-managed-agents-snapshots)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID # found in your dashboard URL
```

See [Snapshots & state persistence](./docs/snapshots-and-state-persistence.md)
for more information.

---

### Step 6. (Optional) Turn on the extras

Browser Rendering, Workers AI, and Email send are wired up out of the
box — disable in `wrangler.jsonc` if you don't want them. VPC bindings
are opt-in.

| Capability | Default | Bindings | Secrets to add | Setup steps |
|---|---|---|---|---|
| Browser Rendering tools | on | `browser` in `wrangler.jsonc` | `CLOUDFLARE_API_TOKEN` (for REST tools) | none |
| Workers AI image gen | on | `ai` in `wrangler.jsonc` | none | none |
| Email send + inbox | on | `send_email` in `wrangler.jsonc`; set `EMAIL_DOMAIN` + `EMAIL_FROM` (Deploy to Cloudflare prompts for these, or `vars` in `wrangler.jsonc` locally) | none | [Email docs](./docs/agent-email.md) |
| VPC private services | off | add `vpc_services` blocks in `wrangler.jsonc` | none | [Workers VPC docs](./docs/connecting-to-private-services.md) |

---

### Step 7. Visit the dashboard

`https://<your-worker>.workers.dev/`. Create an agent (the form lets
you pick MicroVM or Isolate backend), kick off a session, watch the
logs.

---

### Step 8. Secure the dashboard

The Worker validates Cloudflare Access JWTs server-side before serving
the dashboard shell, static assets, `/api/*`, `/openapi.json`, and
`/ws/terminal`, so configure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
before exposing the control plane. Requests without valid Access config
or a valid Access JWT fail closed. `/webhooks` remains reachable and is
authenticated by `WEBHOOK_SECRET`.

See [Cloudflare Access docs](./docs/securing-access.md) for more
information.

---

### Step 9. Customize the control plane (optional)

Fork this repo and modify it to suit your needs or add custom
tools.

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

## Common pitfalls

A handful of edge cases that bite people, most of them around the
empty `id` / `database_id` placeholders in `wrangler.jsonc`:

- **Running `npx wrangler deploy` directly fails.** The committed
  `wrangler.jsonc` has empty KV `id` and `database_id` fields by design;
  wrangler refuses to load that without first running the patch
  scripts. Use the `npm run …` wrappers (which trigger `prebuild`), or
  run `npm run prebuild` once after cloning to populate the IDs in
  your working tree. `npm run cf-typegen` has the same caveat — run
  `prebuild` first if it complains about missing IDs.
- **Don't commit the patched IDs.** After a local deploy the scripts
  write real namespace / database IDs into your working copy of
  `wrangler.jsonc`. Those values are account-specific. If you're
  contributing PRs back to the canonical repo, leave them out of the
  commit (`git checkout wrangler.jsonc` or stage selectively). If
  you're working on a personal fork, committing them is fine — your
  Workers Builds rebuilds will no-op-fast on them.
- **Switching Cloudflare accounts.** The prebuild fast path skips the
  API check when IDs are already populated locally. If you switch the
  `CLOUDFLARE_ACCOUNT_ID` you're deploying to, run
  `git checkout wrangler.jsonc` first so the IDs reset to empty and
  the scripts repopulate against the new account. Otherwise wrangler
  will try the old account's IDs against the new account and fail with
  permission errors.
- **Multi-account local dev.** If your Cloudflare login has access to
  more than one account, the prebuild scripts can't pick one in
  non-interactive mode. Set `CLOUDFLARE_ACCOUNT_ID` (the script's
  error message lists the candidates) before running `npm run deploy`
  or `npm run dev`.
- **Renaming the worker via the Deploy to Cloudflare form.** Safe to
  do — Cloudflare's setup page lets you pick a Worker name to avoid
  collisions with an existing one. The KV namespaces and D1 database
  get the new name as their prefix because the ensure scripts read
  `name` from `wrangler.jsonc` at build time. Just remember to use the
  rewritten URL (`https://<your-chosen-name>.<account>.workers.dev`)
  when configuring the Anthropic webhook in step 2.
- **Deploy to Cloudflare form: you must rename at least one of the
  two KV namespaces.** This repo declares two KV namespaces
  (`SECRETS` and `EGRESS_POLICIES`) and the form's "Configure
  resources" step pre-fills both name inputs with the worker name,
  with no binding suffix — so the first create succeeds and the
  second fails with `Cannot provision a KV Namespace with the title
  "<worker-name>" because it already exists`. Before clicking deploy,
  edit both inputs to be distinct, e.g. `<worker-name>-secrets` and
  `<worker-name>-egress-policies`. `ensure-kv.mjs` will then
  fuzzy-match those names back to the right bindings on every
  subsequent build.

## License

[MIT](./LICENSE)
