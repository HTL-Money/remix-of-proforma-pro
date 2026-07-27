# Pre-Merge Security Checklist

Run through this for every PR that touches data flows, Edge Functions,
migrations, or anything email-related. Items marked 🤖 are enforced by
`src/test/security.test.ts` — they fail the build, not just the review.

## Data & secrets

- [ ] 🤖 No credentials, JWTs, or private keys in any tracked file
- [ ] 🤖 `.env*` still gitignored and untracked
- [ ] 🤖 Built bundle (`dist/`) contains no JWT other than the public anon key
- [ ] New config that reaches the browser is safe to publish (not just "needed a `VITE_` prefix")
- [ ] No credential or token is logged — including Edge Function `console.*`

## Database (RLS)

- [ ] 🤖 No new `anon` grants; the only one is insert-tagged-`source='public'` on `proformas`
- [ ] New tables enable RLS in the same migration that creates them
- [ ] Append-only tables (snapshots, stage_events) still have no update/delete policies
- [ ] If a policy changed: `security/rls-audit.md` updated in the same PR

## Outbound data (emails, attachments, reports)

- [ ] 🤖 Employee compensation data (names, roles, salaries, bonuses) absent from `RecapPayload` and the Word report
- [ ] Everything user-typed that lands in HTML goes through `esc()` (template) — check new template fields
- [ ] New client-supplied binary artifacts are validated server-side by magic bytes + size cap before forwarding
- [ ] Audit log (`recap_emails`) still records fingerprints, never bytes

## Edge Functions

- [ ] Function treats every caller as anonymous (`verify_jwt` passes for the anon key)
- [ ] Rate limiting still applies to any new send/notify path
- [ ] Callers send structured data; the function owns all HTML/formatting

## Browser

- [ ] New external origins (scripts, frames, API hosts) added to the CSP in `vercel.json` deliberately, not by loosening a directive
- [ ] No new inline `<script>` in `index.html` (would require weakening `script-src`)
