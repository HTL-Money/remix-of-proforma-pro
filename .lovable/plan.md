## Enable Lovable Cloud

You asked me to connect Supabase. In Lovable, that's done by enabling **Lovable Cloud**, which provisions a Supabase-backed backend (Postgres database, auth, storage, edge functions, secrets) with no external account setup.

### What I'll do
1. Call the enable-cloud action to provision the backend and wire it into this project.
2. Confirm it's live so we can start using it.

### What this unlocks for the Pro Forma app
- **Saved scenarios** — persist recruit pro formas to a database instead of localStorage, so you can revisit them from any device.
- **Auth (optional)** — gate an internal recruiter view while keeping the public calculator open.
- **Shareable links** — generate a URL for each saved scenario to send to a recruit.
- **File storage** — optionally archive the RETR PDFs alongside their parsed scenario.

### Nothing changes in the calculator yet
Enabling Cloud does not modify the current UI or math. Any of the features above are separate follow-ups you can pick from after it's connected.

### Confirm before I proceed
Reply "go" and I'll enable Cloud. If you also want me to start on one of the features above (most likely **Saved scenarios + shareable links**), tell me which and I'll queue it as the next step.