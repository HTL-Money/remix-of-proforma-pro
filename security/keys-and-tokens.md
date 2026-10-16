# Keys & Tokens Inventory

Every credential the system touches, where it lives, what it can do, and how to
rotate it. **Rule zero: the only secret that may ever appear in client code or
the built bundle is the Supabase anon key** — everything else lives in
server-side secret stores. Rebuilt 2026-10-16: the previous inventory listed
twelve names and said "both deployed functions"; there are eight functions and
the live project holds the entries below.

## Inventory

| Credential | Lives in | Reaches the browser? | Grants / used by |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env` (local), Vercel env vars | Yes (by design) | Nothing — it's an address |
| `VITE_SUPABASE_ANON_KEY` | `.env` (local), Vercel env vars; also Vault `supabase_anon_key` for the cron jobs | **Yes (by design)** | Only what RLS allows `anon`: one tagged insert into `proformas` + Edge Function calls |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase platform (auto-injected into Edge Functions) | **Never** | Bypasses RLS entirely — every function's audit, sourcing, consent, suppression and link writes, and the Auth admin API lookups |
| `ADMIN_TASK_KEY` | Edge Function secret **and** Vault `admin_task_key` (must match) | Never | Gates `weekly-review`'s `send`, `signinReport`, `announce`, `remind`, `notify`. The two pg_cron jobs read it from Vault; the Monday review routine reads it from the Management API secrets list |
| `UNSUBSCRIBE_SECRET` | Edge Function secret | Never | HMAC for the signed unsubscribe URLs minted by `send-recap` and `recruit-optin` (`unsubscribe/token.ts`). Rotating it invalidates the links in every email already sent — those then show the confirmation page without writing anything |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Edge Function secrets | Never | Entra daemon app with `Mail.Send` application permission (`send-recap`, `recruit-optin`, `weekly-review`) |
| `RECAP_SENDER`, `ANNOUNCE_SENDER` | Edge Function secrets | Never (visible as the From address) | Mailboxes the recap / rollout mail sends as |
| `RESEND_API_KEY` | Edge Function secret | Never | Resend send-only API (fallback provider) |
| `SEND_EMAIL_HOOK_SECRET` | Edge Function secret | Never | Verifies Supabase Auth's send-email hook calling `auth-email` |
| `SHARED_TEMP_PASSWORD` | Edge Function secret | Never | The rollout's shared temporary password (`weekly-review announce`). Rollout only; see CLAUDE.md on why excluding someone from the announcement does not rotate it |
| `GAMMA_API_KEY` | Edge Function secret | Never | `gamma-proxy` deck generation |
| `RETR_CLIENT_ID` / `RETR_CLIENT_SECRET` | Edge Function secrets | Never | RETR stats API OAuth (used only inside `retr-proxy`; access/refresh tokens live in function memory, never persisted or logged) |
| `ANTHROPIC_API_KEY`, `NARRATIVE_MODEL` | Edge Function secrets (dormant until set) | Never | The recap's one AI-written opening paragraph (`send-recap/narrativePrompt.ts`); nothing changes until the key exists |
| `RECAP_FROM`, `RECAP_REPLY_TO`, `BOOKING_URL`, `APP_ORIGIN`, `WEEKLY_REVIEW_TO`, `LO_SOURCING_ALERT_TO`, `LO_SOURCING_EXPIRY_DAYS`, `RECAP_TEST_ONLY_TO` | Edge Function secrets | Never (some rendered into emails) | Configuration, not credentials. `RECAP_TEST_ONLY_TO` is the test-mode lock: while set, `send-recap` mails that one address only |
| Vault `supabase_url` | `vault.secrets` | Never | The project URL the cron commands post to; config, not a credential |
| `SUPABASE_ACCESS_TOKEN` | The Claude cloud environment (Management API personal access token) | Never | Everything the Management API allows on the org. **Expired as of 2026-10-16** — see `owner-steps-2026-10-16.md` step 5 |
| Supabase Auth session JWT | Browser localStorage (`sb-*-auth-token`), managed by supabase-js | Yes — it IS the user's session | `authenticated`-role RLS access while valid |
| `recruit_optins.token`, `referral_links.token` | Postgres (`gen_random_bytes`) | Yes — inside the emailed link / the PURL | The consent page (read-only on GET) / HTL5 attribution. Opaque, strictly shaped, validated before any PostgREST filter |

## Token architecture ("is our tokenization robust?")

- **Anon key** — a long-lived signed JWT with role `anon`. Public by design;
  security comes from Postgres RLS evaluating that role, never from hiding the
  key. Everything in [rls-audit.md](./rls-audit.md) assumes the attacker has it.
- **User session tokens** — issued by Supabase Auth on login (JWT, ~1h expiry)
  with a rotating refresh token; `supabase-js` auto-refreshes and stores them
  in localStorage. XSS is the way these leak, which is why the CSP in
  `vercel.json` allows scripts from `'self'` only and why email/user strings
  are HTML-escaped everywhere they render.
- **`verify_jwt` on Edge Functions** validates the *signature*, not the *role*:
  the anon key passes it. All eight functions are therefore written as
  anonymous-facing endpoints — strict input validation, per-recipient rate
  limiting, no caller-controlled HTML, and `ADMIN_TASK_KEY` on anything that
  mails caller-supplied content or anyone but the admin. Identity, where it
  matters (HTL5 attribution, the opt-in and repeat gates, admin overrides),
  comes from `/auth/v1/user` with the caller's bearer — never from the JWT
  payload as sent.
- **Signed opt-out links** — `unsubscribe/token.ts` HMACs the address with
  `UNSUBSCRIBE_SECRET`. The GET only renders a confirmation page; the POST
  (button or RFC 8058 one-click) is what writes the suppression.
- **Graph OAuth token** — client-credentials flow, cached in function memory,
  refreshed 60s before expiry; never persisted, never logged, never returned
  to the caller.
- **Vault** — `admin_task_key`, `supabase_anon_key`, `supabase_url`. The cron
  commands reference `vault.decrypted_secrets` at run time, so neither
  `cron.job` nor `cron.job_run_details` carries a literal (the rows written
  before 2026-10-16 still do — owner step 1c).

## Rotation runbook

Rotate immediately if a credential is suspected leaked; otherwise on team
member departure and annually.

How to set a function secret from here: Dashboard → Edge Functions → Secrets;
the Management API `POST /v1/projects/{ref}/secrets`; or the Supabase MCP
`create_edge_function_secret` (which asks the owner to type the value in the
dashboard — the value never passes through the session). The Supabase CLI
does not work from the Claude cloud container.

1. **Supabase anon key / service role key**: Dashboard → Settings → API →
   "Roll" the key. Then update: Vercel env vars (anon), `.env` locally (anon),
   and Vault `supabase_anon_key` (anon, for the cron jobs). The service key
   auto-updates for Edge Functions. Old JWTs die when the JWT secret is
   rolled — all users re-login.
2. **`ADMIN_TASK_KEY`** — two places, together: the function secret and
   `select vault.update_secret((select id from vault.secrets where name =
   'admin_task_key'), '<new>')`. Prove it with a `remind` dry run from Vault
   (200) and with the old value (403) before the next 13:00 UTC firing.
3. **Graph client secret**: Entra admin center → App registrations → the
   daemon app → Certificates & secrets → new secret → set
   `GRAPH_CLIENT_SECRET` → delete the old one after the functions' next cold
   start.
4. **Resend key**: Resend dashboard → revoke + re-issue → set
   `RESEND_API_KEY`.
5. **RETR client secret**: request reissue through RETR's standard support
   channel → set `RETR_CLIENT_SECRET` → confirm one live lookup → old secret
   dies upstream.
6. **`UNSUBSCRIBE_SECRET`**: only with a reason — every opt-out link already
   in a mailbox stops verifying. The footer's `mailto:` fallback and the
   confirmation page's wording cover the gap.
7. **A leaked commit**: rotating the credential is the fix — git history
   rewriting is cosmetic. Then add the leaked pattern to the secret-scan
   regexes in `src/test/security.test.ts` so it can't come back.

## Handling rules

- Never `console.log` a credential, a JWT, or a full `Authorization` header —
  including in Edge Function logs. The migration that moved the cron secrets
  into Vault did it with `substring()` inside SQL so the values never left
  the database.
- New Edge Function secrets go in via the dashboard / API / MCP, never into
  `config.toml`, migrations, or source. A cron command never carries a
  literal: reference `vault.decrypted_secrets`.
- New client-visible config must be prefixed `VITE_` *and* be safe to publish —
  those two things must be decided together; "it needs a VITE_ prefix to work"
  is never, alone, a reason to expose something.
