# Deploy runbook — Netlify

Globetrotty runs as one Netlify site: the Next.js app (pages, `/api/*` routes, the `proxy.ts`
edge middleware that refreshes the Supabase session) plus three Netlify functions bundled from
`netlify/functions/`:

| Function | Kind | Trigger |
|---|---|---|
| `run-turn-background` | background | POST from the app / sweeper, `x-worker-secret` header |
| `sweep` | scheduled | every 5 minutes (`netlify.toml`) |
| `drift-monitor` | scheduled | 03:00 UTC daily |

Site: **globtrotty** on the `dan-neciu` Netlify team → https://globtrotty.netlify.app
(admin: https://app.netlify.com/projects/globtrotty). Supabase project: `globetrotty`, West EU.

## 1. Prerequisites

- Node 22 (`nvm use 22`), `pnpm`, `netlify-cli` ≥ 24 (`pnpm dlx netlify-cli` works), `supabase` CLI ≥ 2.98.
- `netlify login` and `supabase login` done once on the machine.
- A filled `.env.local` (names in `.env.example`; never commit it).

## 2. Link (once per clone)

```sh
netlify link --id 05b48ca7-039f-43f5-b39a-8f13cb455295   # writes .netlify/state.json (git-ignored)
echo | supabase link --project-ref <ref from SUPABASE_URL>  # blank DB password is fine for config push
```

## 3. Environment variables

Every name in `.env.example` must exist on the site. Non-secret names are set on all contexts;
secrets must be scoped to the non-development contexts (the CLI refuses `--secret` otherwise).
`SITE_URL` on Netlify is the public site URL, not the local one.

```sh
netlify env:set SITE_URL https://globtrotty.netlify.app
netlify env:set SUPABASE_URL "$SUPABASE_URL"
netlify env:set NEXT_PUBLIC_SUPABASE_URL "$SUPABASE_URL"
netlify env:set NEXT_PUBLIC_SUPABASE_ANON_KEY "$SUPABASE_ANON_KEY"
for k in DATABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY WORKER_SHARED_SECRET ANTHROPIC_API_KEY GOOGLE_SEARCH_API; do
  netlify env:set "$k" "${!k}" --secret --context production --context deploy-preview --context branch-deploy
done
netlify env:list --context production   # names only; values are masked
```

`SUPABASE_SERVICE_ROLE_KEY` is only read by the harness's tests and tooling — nothing under
`app/` or `web/` imports it. Keep it on the site anyway so the functions' `loadEnv` passes.

## 4. Supabase auth URLs

Magic links redirect to `/auth/callback`; Supabase rejects any redirect target not on its
allow-list and silently falls back to `site_url`. `supabase/config.toml` `[auth]` carries:

```toml
site_url = "https://globtrotty.netlify.app"
additional_redirect_urls = ["https://globtrotty.netlify.app/auth/callback", "http://localhost:3000/auth/callback"]
```

Push with `supabase config push`. **Read the diff before answering `y`** — the command pushes the
whole `[auth]` section, so any key where the file disagrees with the dashboard gets overwritten.
The file was aligned with the live project on 2026-09-19 (MFA TOTP on, email confirmations on,
OTP length 8, 1-minute email frequency); if the diff shows anything beyond the two URLs, fix the
file first. Dashboard fallback: Authentication → URL Configuration → Site URL + Redirect URLs.

The email+password provider must also be enabled (dashboard) — `test/rls.live.test.ts` signs its
two throwaway users in that way.

## 5. Build and deploy

```sh
netlify build                      # local dry run; check the function list below
netlify deploy --build --prod      # builds again on the deploy and publishes
```

The build log must list `drift-monitor.mts`, `run-turn-background.mts`, `sweep.mts` under
"Packaging Functions" and `___netlify-edge-handler-node-middleware` under "Packaging Edge
Functions" — that edge handler is `proxy.ts`; if it is missing, session refresh and the anonymous
redirect are silently off. The prompt files ride along via `included_files` in `netlify.toml`;
confirm with `unzip -l .netlify/functions/run-turn-background.zip | grep prompts/`.

Next builds with `next build --webpack` (see `package.json`): Turbopack cannot resolve the
harness's `.js`-suffixed imports.

## 6. Smoke

```sh
curl -sI https://globtrotty.netlify.app/login | grep -i content-security-policy   # 200 + CSP
curl -s -o /dev/null -w '%{http_code}\n' https://globtrotty.netlify.app/            # 307 → /login
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://globtrotty.netlify.app/api/conversations/x/messages -d '{}'   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://globtrotty.netlify.app/.netlify/functions/run-turn-background -d '{}'
```

The last one prints **202**, not 401: Netlify answers a *background* function with 202 as soon as
the request is queued, before the handler runs. The handler's 401 (missing `x-worker-secret`) is
only visible in the function log — `netlify logs:function run-turn-background` while sending the
request; an invocation that finishes in a few hundred ms with no error line is the rejected path,
an error line mentioning `prompts` or `ENOENT` means the prompt files were not bundled.
A **307** here means `proxy.ts`'s matcher stopped excluding `/.netlify/` — no turn can start.

Then sign in by magic link, send a message, and watch `conversations.status` go `working` →
`awaiting_user` (or `failed` with the reason in the status line — with no Anthropic credit the
turn fails `provider_rejected`, which still proves the chain).

## 7. Rotating `WORKER_SHARED_SECRET`

The app's `/api/*` routes send it, `run-turn-background` checks it, and the sweeper re-invokes
with it, all reading the same env var at cold start — so a rotation is one value change plus a
redeploy (functions cache env at bundle time on Netlify):

```sh
openssl rand -hex 32 | pbcopy
netlify env:set WORKER_SHARED_SECRET "<new>" --secret --context production --context deploy-preview --context branch-deploy
netlify deploy --build --prod
```

Update `.env.local` too. Turns queued by the old value that had not started are rejected with a
401 in the log; the 5-minute sweeper re-invokes them with the new value.

## 8. Logs

- Functions: https://app.netlify.com/projects/globtrotty/logs/functions or `netlify logs:function <name>`
- Edge (proxy): https://app.netlify.com/projects/globtrotty/logs/edge-functions
- Deploys: https://app.netlify.com/projects/globtrotty/deploys
