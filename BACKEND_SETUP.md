# Backend Setup — Pro Forma Submissions

The submit button stores each completed pro forma in Supabase and emails a
visual comparison (the 3D chart + breakdown) to the recruiting team and,
optionally, to the loan officer. One-time setup, ~15 minutes.

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In the SQL Editor, paste and run `supabase/migrations/0001_proforma_submissions.sql`.
3. From **Project Settings → API**, copy the **Project URL** and **anon public** key
   into a `.env.local` file at the repo root (see `.env.example`):

   ```
   VITE_SUPABASE_URL=https://<your-project-id>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```

## 2. Resend (email)

1. Create an account at [resend.com](https://resend.com).
2. Verify the sending domain (`htlmoney.com`) under **Domains** — the function
   sends from `noreply@htlmoney.com`. Until the domain is verified you can test
   with Resend's sandbox address instead.
3. Create an API key.

## 3. Deploy the edge function

With the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in:

```sh
supabase link --project-ref <your-project-id>
supabase secrets set RESEND_API_KEY=re_xxxx
supabase secrets set RECRUITER_EMAIL=recruiting@htlmoney.com
supabase secrets set ALLOWED_ORIGIN=https://your-deployed-app-domain.com
supabase functions deploy submit-proforma
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
the platform — you do not need to set them.)

`ALLOWED_ORIGIN` locks down the function's CORS policy to your app's exact
origin (scheme + host, no trailing slash — e.g. `https://proforma.htlmoney.com`).
If you skip this it defaults to `*` (any site can call the function), which is
fine for local development but should be set before going live publicly.

## 4. Verify end-to-end

1. `npm run dev` and open the app (add `?demo=1` to the URL for sample data).
2. Fill every field in the Submit checklist, including **Current Platform BPS**
   and optionally **Your Email**.
3. Click **Submit Pro Forma** — you should see a success toast, a new row in
   the `proforma_submissions` table, and the comparison email (with the chart
   image inline) in the recruiter inbox and the LO inbox if provided.

## Notes

- The `proforma_submissions` table has row-level security enabled with **no**
  policies: the browser can never read submissions; only the edge function
  (service role) writes them.
- The chart in the email is a PNG snapshot of the exact 3D scene the LO saw
  in the app, attached inline via `cid`.
- If the email fails (bad Resend key, unverified domain), the submission is
  still saved and the app shows a "Submitted — email pending" warning.
