# Keys & Tokens Inventory

Every credential the system touches, where it lives, what it can do, and how to
rotate it. **Rule zero: the only secret that may ever appear in client code or
the built bundle is the Supabase anon key** — everything else lives in
server-side secret stores.

## Inventory

| Credential | Lives in | Reaches the browser? | Grants |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env` (local), Vercel env vars | Yes (by design) | Nothing — it's an address |
| `VITE_SUPABASE_ANON_KEY` | `.env` (local), Vercel env vars | **Yes (by design)** | Only what RLS allows `anon`: one tagged insert into `proformas` + Edge Function calls |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase platform (auto-injected into Edge Functions) | **Never** | Bypasses RLS entirely — Edge Function internals only (`send-recap` uses it for the rate-limit query + audit-log insert) |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Supabase function secrets | Never | Entra daemon app with `Mail.Send` application permission |
| `RECAP_SENDER` | Supabase function secrets | Never | Mailbox the recap sends as |
| `RESEND_API_KEY` | Supabase function secrets | Never | Resend send-only API |
| `RECAP_FROM`, `BOOKING_URL` | Supabase function secrets | Never (rendered into emails) | Configuration, not credentials |
| `RETR_CLIENT_ID` / `RETR_CLIENT_SECRET` | Supabase function secrets | Never | RETR stats API OAuth (used only inside `retr-proxy`; access/refresh tokens live in function memory, never persisted or logged) |
| Supabase Auth session JWT | Browser localStorage (`sb-*-auth-token`), managed by supabase-js | Yes — it IS the user's session | `authenticated`-role RLS access while valid |

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
  the anon key passes it. Both deployed functions are therefore written as
  anonymous-facing endpoints — strict input validation, per-recipient rate
  limiting, and no caller-controlled HTML or content types (attachments are
  verified by magic bytes server-side).
- **Graph OAuth token** — client-credentials flow inside `send-recap`, cached
  in function memory, refreshed 60s before expiry; never persisted, never
  logged, never returned to the caller.

## Rotation runbook

Rotate immediately if a credential is suspected leaked; otherwise on team
member departure and annually.

1. **Supabase anon key / service role key**: Supabase Dashboard → Settings →
   API → "Roll" the key. Then update: Vercel env vars (anon), `.env` locally
   (anon). The service key auto-updates for Edge Functions. Old JWTs die when
   the JWT secret is rolled — all users re-login.
2. **Graph client secret**: Entra admin center → App registrations → the
   daemon app → Certificates & secrets → new secret → `supabase secrets set
   GRAPH_CLIENT_SECRET=...` → delete the old one after the function's next
   cold start.
3. **Resend key**: Resend dashboard → revoke + re-issue → `supabase secrets
   set RESEND_API_KEY=...`.
3b. **RETR client secret**: request reissue from RETR (kevan@retr.app) →
   `supabase secrets set RETR_CLIENT_SECRET=...` → confirm one live lookup →
   old secret dies upstream. **Do this after initial go-live**: the first
   credentials transited a chat channel during setup and should be treated as
   exposed-once.
4. **A leaked commit**: rotating the credential is the fix — git history
   rewriting is cosmetic. Then add the leaked pattern to the secret-scan
   regexes in `src/test/security.test.ts` so it can't come back.

## Handling rules

- Never `console.log` a credential, a JWT, or a full `Authorization` header —
  including in Edge Function logs.
- New Edge Function secrets go in via `supabase secrets set`, never into
  `config.toml`, migrations, or source.
- New client-visible config must be prefixed `VITE_` *and* be safe to publish —
  those two things must be decided together; "it needs a VITE_ prefix to work"
  is never, alone, a reason to expose something.
