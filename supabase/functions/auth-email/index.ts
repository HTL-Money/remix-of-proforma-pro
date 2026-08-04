// Supabase Auth "Send Email" hook. Auth would otherwise mail from a generic
// supabase.io sender, which for a password reset is exactly the mail people are
// trained to distrust — and it is rate-limited besides. This routes those emails
// through the same Microsoft Graph sender the recap and rollout mail already use,
// so everything the team receives comes from hometownlend.com.
//
// Deliberately NOT SMTP: this tenant's Graph app-registration credentials are
// already provisioned and proven, and SMTP AUTH would need a new basic-auth
// credential that modern M365 tenants disable by default.
//
// Supabase POSTs { user, email_data } and signs the request. The recipient is
// taken from Supabase's payload and never from anything caller-controlled, so
// the worst a forged call can do is mail a real user a link that will not work
// (the token in it must match what Auth issued).

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#13294B";
const SITE = Deno.env.get("APP_ORIGIN") || "https://htlrecruit.broker";

// ---- Graph send (same shape as weekly-review / send-recap) -------------------

interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; sender: string }

const graphConfig = (): GraphConfig | null => {
  const tenantId = Deno.env.get("GRAPH_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET");
  const sender = Deno.env.get("RECAP_SENDER");
  return tenantId && clientId && clientSecret && sender ? { tenantId, clientId, clientSecret, sender } : null;
};

let graphToken: { token: string; expiresAt: number } | null = null;

const getGraphToken = async (cfg: GraphConfig): Promise<string> => {
  if (graphToken && graphToken.expiresAt > Date.now()) return graphToken.token;
  const resp = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Graph token ${resp.status}`);
  const data = await resp.json();
  graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return graphToken.token;
};

const sendEmailTo = async (to: string, subject: string, html: string): Promise<void> => {
  const cfg = graphConfig();
  if (!cfg) throw new Error("Graph email is not configured.");
  const message = { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] };
  const post = (token: string) =>
    fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
      signal: AbortSignal.timeout(30_000),
    });
  let resp = await post(await getGraphToken(cfg));
  if (resp.status === 401) { graphToken = null; resp = await post(await getGraphToken(cfg)); }
  if (resp.status !== 202) throw new Error(`Graph send ${resp.status}: ${await resp.text().catch(() => "")}`);
};

// ---- Templates ---------------------------------------------------------------

const shell = (heading: string, body: string) => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:${NAVY};color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">
    <div style="font-size:19px;font-weight:700">Hometown Lending</div>
  </div>
  <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:22px">
    <h2 style="margin:0 0 12px;color:${NAVY};font-size:18px">${escHtml(heading)}</h2>
    ${body}
    <p style="margin:18px 0 0;font-size:12px;color:#7a7a7a">
      If you didn't ask for this, you can ignore it — nothing changes until the link is used.
    </p>
  </div>
</div>`;

const button = (href: string, label: string) => `
<p style="margin:16px 0">
  <a href="${escHtml(href)}" style="background:${NAVY};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;display:inline-block">${escHtml(label)}</a>
</p>
<p style="margin:0;font-size:12px;color:#7a7a7a">Or paste this into your browser:<br>${escHtml(href)}</p>`;

/** Subject + HTML for the action Supabase is asking us to send. */
const render = (action: string, link: string): { subject: string; html: string } => {
  switch (action) {
    case "recovery":
      return {
        subject: "Reset your Hometown Lending password",
        html: shell("Reset your password", `
          <p style="margin:0 0 8px">Choose a new password for the LO Pro Forma tool. This link is single-use and expires shortly.</p>
          ${button(link, "Choose a new password")}`),
      };
    case "invite":
    case "signup":
      return {
        subject: "Your Hometown Lending sign-in",
        html: shell("Confirm your account", `
          <p style="margin:0 0 8px">Confirm your account to finish setting up your sign-in.</p>
          ${button(link, "Confirm my account")}`),
      };
    case "email_change":
    case "email_change_new":
      return {
        subject: "Confirm your new email address",
        html: shell("Confirm your new email address", `
          <p style="margin:0 0 8px">Confirm this address to finish moving your sign-in to it.</p>
          ${button(link, "Confirm this address")}`),
      };
    case "magiclink":
      return {
        subject: "Your Hometown Lending sign-in link",
        html: shell("Sign in", `
          <p style="margin:0 0 8px">Use this link to sign in. It is single-use and expires shortly.</p>
          ${button(link, "Sign in")}`),
      };
    default:
      return {
        subject: "Hometown Lending account notice",
        html: shell("Account notice", `<p style="margin:0 0 8px">Follow the link below to continue.</p>${button(link, "Continue")}`),
      };
  }
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body: {
    user?: { email?: string };
    email_data?: { token_hash?: string; redirect_to?: string; email_action_type?: string };
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const to = body.user?.email;
  const data = body.email_data ?? {};
  const action = data.email_action_type ?? "recovery";
  if (!to || !data.token_hash) return json(400, { error: "Missing user email or token." });

  // Build the verification URL ourselves: Auth hands over the token hash and the
  // app's redirect target, and /auth/v1/verify exchanges the one for a session on
  // the other. Falling back to SITE keeps a malformed redirect from producing a
  // link that goes nowhere.
  const redirect = data.redirect_to || `${SITE}/reset`;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const link = `${supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(data.token_hash)}` +
    `&type=${encodeURIComponent(action)}&redirect_to=${encodeURIComponent(redirect)}`;

  const { subject, html } = render(action, link);
  try {
    await sendEmailTo(to, subject, html);
  } catch (e) {
    // A non-2xx tells Auth the send failed, so it can surface/retry rather than
    // reporting success for mail that never left.
    console.error("auth email send failed", action, e);
    return json(502, { error: "Send failed." });
  }
  return json(200, {});
});
