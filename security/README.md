# Security Posture — HTL Pro Forma

This folder is the security contract for the app: what we protect, from whom,
how, and how it's **enforced automatically** (not just documented). Every claim
in these files is true of the code as it exists today — if you change the
posture, change these files in the same PR, and `src/test/security.test.ts`
will fail the build if the enforced parts drift.

## Threat model

The app protects against **outsiders and insiders**. Since the August 2026
rollout there are ~51 signed-in accounts, split by `public.is_admin()` into
admins (the whole CRM) and loan officers (only rows they created — see
[rls-audit.md](./rls-audit.md)). The adversaries considered:

| Adversary | What they hold | What they must never get |
|---|---|---|
| Anonymous visitor | The public calculator URL | Any stored pro forma, RETR report, target list, snapshot, or email log |
| Anon-key holder | The `VITE_SUPABASE_ANON_KEY` (ships in the JS bundle — public **by design**) | Anything beyond: one tagged insert into `proformas`, and rate-limited calls to the recap Edge Function |
| Signed-in loan officer | A real session | Other LOs' submissions, sends, links and invites; the target list; the ability to plant rows under another LO's id, write snapshots against someone else's pro forma, or upload a "verified" RETR report |
| Email recipient | A recap email (numbers, chart, animation, Word report) | Employee compensation data, API keys, other people's pro formas |
| Link scanner (Safe Links, Proofpoint) | Every URL in a delivered email, fetched by GET | The ability to consent or unsubscribe on the recipient's behalf — so no GET writes anything |
| Search engines / embedders | Nothing | The page itself (`noindex`, `frame-ancestors 'none'`) |

## Data classification

| Class | Data | Where it lives | Who can read it |
|---|---|---|---|
| **Most sensitive** | Employee names, roles, salaries, bonuses (inside `ModelState`) | `proformas.data`, `proforma_snapshots.data` (JSONB) | the owning LO or an admin (RLS) — **never** enters emails, charts, GIFs, or Word reports |
| Sensitive | RETR production reports, target-LO lists, pipeline stages, email audit log, consent records | `retr_reports`, `target_los`, `stage_events`, `recap_emails`, `recruit_optins` | admins; LOs see their own sends and invites, and may read RETR reports (RLS) |
| Shareable | `RecapPayload` — LO name, NMLS, production totals, comp comparison | Built client-side (`buildRecapPayload`), emailed to the address the sender enters | The email recipient |
| Public | The calculator UI and its client-side math | The JS bundle | Everyone |

The isolation boundary is `buildRecapPayload` (`src/lib/recapEmail.ts`): it is
the ONLY constructor of outbound data, and it copies specific numeric fields —
it never spreads `ModelState`. The chart (`recapChart.ts`), vault animation
(`vaultAnimation.ts`/`vaultGif.ts`), and Word report (`recapDocx.ts`) all
consume `RecapPayload`, so they inherit the boundary. Enforced by the
payload-isolation test.

## Enforcement map

| Control | Where | Automated check |
|---|---|---|
| RLS: outsiders read nothing | `supabase/migrations/*` | `security.test.ts` replays every migration's policy statements and asserts the only live anon grant is insert-only, tagged `source='public'`, on `proformas` |
| RLS: the CRM boundary is `is_admin()` | `supabase/migrations/*` | `security.test.ts` asserts the admin-only tables name `is_admin()` in the policy body and the own-or-admin selects name `auth.uid()`; storage write policies name `is_admin()` |
| SECURITY DEFINER functions not callable by anon | `supabase/migrations/*` | `security.test.ts` finds every definer function in the migrations and requires a matching `revoke execute … from anon` |
| Migration ledger | `supabase_migrations.schema_migrations` on the project | `security.test.ts` requires ledger-shaped, unique filenames; every applied file is recorded by version (see CLAUDE.md) |
| CI runs all of this | `.github/workflows/ci.yml` | typecheck, lint, build, tests (including the bundle check, which fails rather than skips under CI), production audit at `high` |
| No secrets in the repo | — | `security.test.ts` scans every tracked file for JWTs, provider key prefixes, private-key blocks |
| `.env` never committed | `.gitignore` | `security.test.ts` asserts `.env*` is ignored and untracked |
| No secrets in the shipped bundle | `dist/` | `security.test.ts` scans the build output (when present) for any JWT other than the public anon key |
| Edge Function abuse guards | `supabase/functions/send-recap/index.ts` | 5 sends/hour/recipient on the normalized address; strict payload validation (NMLS canonicalized once, names capped); attachments verified by magic bytes + size caps (PNG ≤1.5MB, GIF ≤2MB, DOCX ≤1MB decoded); the internal negative-gain alert runs after every gate and is capped per hour |
| The four send gates | `send-recap/sourcing.ts` (pure) + `index.ts` | suppression (fail-closed) → split (`decideSplit`) → HTL5 claim (`decideSourcingAction`) → opt-in (`decideOptinSend`) → one-per-NMLS (`decideRepeatSend`); each decision is unit-tested; `edgeGates.test.ts` pins the order in the handler |
| Mail-sending actions are keyed | `weekly-review/index.ts` | `edgeGates.test.ts` requires `adminKeyOk` on every action except `collect` |
| GET never writes | `recruit-optin`, `unsubscribe` | `edgeGates.test.ts` + the page tests: the emailed link renders a confirmation page; only the button's POST (or an RFC 8058 one-click POST) records consent / suppression |
| Email audit trail | `recap_emails` table | Every send logged: recipient, sender JWT subject, numbers, artifact fingerprints (SHA-256 + size) — never bytes |
| Browser hardening | `vercel.json` | CSP (self + Supabase only), `frame-ancestors 'none'`, HSTS, nosniff |
| XSS in emails | `template.ts` `esc()` | Template tests assert user strings are escaped |

## Known accepted risks

1. **The anon key is public.** This is Supabase's intended architecture — the
   key only grants what RLS allows. The entire posture above assumes the key
   is in the attacker's hands.
2. **`verify_jwt` does not mean "signed in."** The anon key is itself a valid
   project JWT, so Edge Functions are reachable anonymously. All eight are
   designed for this: `send-recap` owns its template (callers send numbers,
   never HTML), validates every byte it forwards, and rate-limits per
   recipient; identity for the gates comes from `/auth/v1/user`, never the
   bearer's payload; `weekly-review` additionally requires `ADMIN_TASK_KEY`.
2b. **The opt-in and repeat gates fail OPEN on a lookup outage** (the
   suppression check fails closed). Deliberate when written; flagged by the
   2026-10-16 audit as the owner's call — see `owner-steps-2026-10-16.md`.
3. **Anonymous submission spam.** Anyone with the anon key can insert tagged
   rows into `proformas` (`source='public'`). Impact is limited to noise in
   the team's saved list; rows carry no privileges. Revisit if it's abused in
   practice (captcha or a lightweight proof-of-work would slot into
   `submitPublicProforma`).
3b. **NMLS enumeration through `retr-proxy`.** The anonymous self-serve flow
   is the product's core premise, so the proxy is anon-reachable by design —
   which also means anyone with the anon key can look up any LO's production
   stats through it. Backstops: strict input validation, 24-hour cache-first,
   and a global upstream budget (150 RETR calls/day → 429), so bulk scraping
   is slow and capped, and the underlying data is commercially available from
   RETR anyway. Accepted at current scale; a per-IP throttle is the designated
   next step if the budget starts tripping.
4. **Encryption at rest** is whatever the Supabase tier provides (AES-256 at
   the infrastructure level). No application-layer encryption — acceptable for
   this data class; revisit if regulated data ever enters `ModelState`.
5. **npm audit residuals.** Vulnerabilities that `npm audit fix` can't resolve
   without breaking majors are listed here, with reasoning. Runtime findings
   are never accepted without a written exposure analysis. As of 2026-10-16
   `npm audit --omit=dev --audit-level=high` passes (it is the CI gate): the
   only production entries are the two react-router advisories below, both
   moderate. `tailwindcss-animate` moved to devDependencies so the Tailwind
   build chain no longer counts as runtime; `vite.config.ts` no longer binds
   the dev server to every interface, which was the one condition under which
   the open Vite 5 dev-server advisories applied. Earlier residuals, kept for
   the record (2026-07-27, after a 17 → 9 semver-compatible fix pass):
   - `eslint <10` tree (6 advisories, high): all one root cause — a
     `brace-expansion`/`minimatch` DoS in **lint tooling**. devDependency
     only, never shipped, only ever run by developers/CI on trusted input.
     Real fix is the eslint 9→10 major, tracked with the toolchain migration.
   - `esbuild`/`vite` (moderate/high): same **local dev server** advisories
     as before plus a dev-server path-traversal — production ships static
     files; no dev server exists in deployment. Fix requires Vite 5→8, a
     breaking toolchain migration tracked separately. Mitigation until then:
     don't run `npm run dev` on untrusted networks with sensitive data loaded.
   - `react-router`/`react-router-dom 6.x` (moderate, **runtime — analyzed,
     not waved through**): two advisories, both requiring v7.18+ (the whole
     6.x line is affected; 6→7 is a breaking migration). Exposure analysis:
     (a) *open redirect via backslash in `<Link>`/`useNavigate`* needs an
     attacker-controlled **path** — every router target in this app is a
     hardcoded internal path; the only dynamic piece is a query string
     appended to a fixed `/calculator` path, which can't change the path
     portion. (b) *constructor injection via `deserializeErrors()`* is SSR
     hydration — this is a pure SPA with no SSR. Neither vector is reachable.
     Revisit at the react-router 7 migration.
   - Previously fixed and still fixed: react-router XSS (the 2026-07 patch),
     `pdfjs-dist` 4.7→4.10 (which also removed the abandoned
     `canvas`/`node-pre-gyp`/`tar` install chain and its critical advisory).

## Rotation runbook

See [keys-and-tokens.md](./keys-and-tokens.md#rotation-runbook).
