# Security Posture — HTL Pro Forma

This folder is the security contract for the app: what we protect, from whom,
how, and how it's **enforced automatically** (not just documented). Every claim
in these files is true of the code as it exists today — if you change the
posture, change these files in the same PR, and `src/test/security.test.ts`
will fail the build if the enforced parts drift.

## Threat model

The app protects against **outsiders** — the three team accounts trust each
other and share full access by design. The adversaries considered:

| Adversary | What they hold | What they must never get |
|---|---|---|
| Anonymous visitor | The public calculator URL | Any stored pro forma, RETR report, target list, snapshot, or email log |
| Anon-key holder | The `VITE_SUPABASE_ANON_KEY` (ships in the JS bundle — public **by design**) | Anything beyond: one tagged insert into `proformas`, and rate-limited calls to the recap Edge Function |
| Email recipient | A recap email (numbers, chart, animation, Word report) | Employee compensation data, API keys, other people's pro formas |
| Search engines / embedders | Nothing | The page itself (`noindex`, `frame-ancestors 'none'`) |

## Data classification

| Class | Data | Where it lives | Who can read it |
|---|---|---|---|
| **Most sensitive** | Employee names, roles, salaries, bonuses (inside `ModelState`) | `proformas.data`, `proforma_snapshots.data` (JSONB) | `authenticated` only (RLS) — **never** enters emails, charts, GIFs, or Word reports |
| Sensitive | RETR production reports, target-LO lists, pipeline stages, email audit log | `retr_reports`, `target_los`, `stage_events`, `recap_emails` | `authenticated` only (RLS) |
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
| No secrets in the repo | — | `security.test.ts` scans every tracked file for JWTs, provider key prefixes, private-key blocks |
| `.env` never committed | `.gitignore` | `security.test.ts` asserts `.env*` is ignored and untracked |
| No secrets in the shipped bundle | `dist/` | `security.test.ts` scans the build output (when present) for any JWT other than the public anon key |
| Edge Function abuse guards | `supabase/functions/send-recap/index.ts` | 5 sends/hour/recipient; strict payload validation; attachments verified by magic bytes + size caps (PNG ≤1.5MB, GIF ≤2MB, DOCX ≤1MB decoded) |
| Email audit trail | `recap_emails` table | Every send logged: recipient, sender JWT subject, numbers, artifact fingerprints (SHA-256 + size) — never bytes |
| Browser hardening | `vercel.json` | CSP (self + Supabase only), `frame-ancestors 'none'`, HSTS, nosniff |
| XSS in emails | `template.ts` `esc()` | Template tests assert user strings are escaped |

## Known accepted risks

1. **The anon key is public.** This is Supabase's intended architecture — the
   key only grants what RLS allows. The entire posture above assumes the key
   is in the attacker's hands.
2. **`verify_jwt` does not mean "signed in."** The anon key is itself a valid
   project JWT, so Edge Functions are reachable anonymously. Both functions
   are designed for this: `send-recap` owns its template (callers send numbers,
   never HTML), validates every byte it forwards, and rate-limits per
   recipient.
3. **Anonymous submission spam.** Anyone with the anon key can insert tagged
   rows into `proformas` (`source='public'`). Impact is limited to noise in
   the team's saved list; rows carry no privileges. Revisit if it's abused in
   practice (captcha or a lightweight proof-of-work would slot into
   `submitPublicProforma`).
4. **Encryption at rest** is whatever the Supabase tier provides (AES-256 at
   the infrastructure level). No application-layer encryption — acceptable for
   this data class; revisit if regulated data ever enters `ModelState`.
5. **npm audit residuals.** Vulnerabilities that `npm audit fix` can't resolve
   without breaking majors are listed here, with reasoning. Runtime findings
   are never accepted. Current residuals (2026-07-23, after fixing 20 → 2):
   - `esbuild <=0.24.2` (moderate) + its `vite <=6.4.2` parent (high): the
     advisory is against the **local dev server** (any website can read dev
     responses while `npm run dev` is running). Production ships static files
     — no dev server exists in deployment. Fix requires Vite 5→8, a breaking
     toolchain migration tracked separately. Mitigation until then: don't run
     `npm run dev` on untrusted networks with sensitive data loaded.
   - Everything else was fixed: react-router XSS (runtime — patched in place),
     and the `pdfjs-dist` 4.7→4.10 bump, which also removed the abandoned
     `canvas`/`node-pre-gyp`/`tar` install chain that carried a critical-rated
     advisory (install-time tooling, never shipped, now gone entirely).

## Rotation runbook

See [keys-and-tokens.md](./keys-and-tokens.md#rotation-runbook).
