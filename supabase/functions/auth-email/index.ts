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
// Supabase POSTs { user, email_data } and SIGNS the request; this function
// verifies that signature and rejects anything else with a 401.
//
// The earlier version did not, on the reasoning that a forged call could only
// mail a real user a dud link. That reasoning was wrong: the recipient comes out
// of the request body, so an unsigned endpoint let anyone on the internet send
// hometownlend.com-branded mail, with our HTML and our logo, to any address they
// liked. The token being useless does not matter when the payload is the attack.
// Verified by forging a call with a bogus token: it returned 200 and Graph sent
// the mail. Hence standard-webhooks verification below, failing closed.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAVY = "#13294B";
const SITE = Deno.env.get("APP_ORIGIN") || "https://htlrecruit.broker";

// ---- Webhook signature (standard-webhooks, as Supabase Auth sends it) --------
//
// Auth signs with the secret configured as `hook_send_email_secrets`, stored in
// the form `v1,whsec_<base64>`; the signing key is the decoded bytes after
// `whsec_`. The signed payload is `{id}.{timestamp}.{rawBody}` and the
// `webhook-signature` header carries one or more space-separated `v1,<b64sig>`
// entries (more than one during a secret rotation).

/** Constant-time compare, so a wrong signature can't be narrowed byte by byte. */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const signingKey = (): Uint8Array | null => {
  const raw = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
  if (!raw) return null;
  // Tolerate the secret being pasted with or without the `v1,whsec_` wrapper —
  // the config value carries it, a bare base64 key does not.
  const b64 = raw.replace(/^v1,/, "").replace(/^whsec_/, "");
  try {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    console.error("SEND_EMAIL_HOOK_SECRET is not valid base64");
    return null;
  }
};

/** True when `body` carries a signature Auth could have produced for it. */
const signatureValid = async (req: Request, body: string): Promise<boolean> => {
  const key = signingKey();
  if (!key) return false; // fail closed — never skip the check
  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const header = req.headers.get("webhook-signature");
  if (!id || !ts || !header) return false;

  // Reject stale timestamps so a captured request can't be replayed later.
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > 300) {
    console.error("webhook timestamp outside tolerance", ts);
    return false;
  }

  const mac = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // Any one of the offered signatures matching is enough; that is what makes a
  // secret rotation possible without dropping mail mid-flight.
  return header.split(" ").some(part => {
    const [version, value] = part.split(",");
    return version === "v1" && value != null && sameSecret(value, expected);
  });
};

// ---- Graph send (same shape as weekly-review / send-recap) -------------------

interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; sender: string }

const graphConfig = (): GraphConfig | null => {
  const tenantId = Deno.env.get("GRAPH_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET");
  // ANNOUNCE_SENDER (jamesm@) first: account emails should come from the person
  // who runs the rollout, not whichever mailbox the recap pipeline uses.
  const sender = Deno.env.get("ANNOUNCE_SENDER") || Deno.env.get("RECAP_SENDER");
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

  // Read the body ONCE, as text: the HMAC is computed over the exact bytes Auth
  // signed, and a Request body cannot be consumed twice. Parsing comes after.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json(400, { error: "Unreadable body." });
  }

  if (Deno.env.get("SEND_EMAIL_HOOK_SECRET") === undefined) {
    // Refuse rather than send unverified. A missing secret is a deployment
    // mistake, and treating it as "skip the check" is how this hole reopens.
    console.error("SEND_EMAIL_HOOK_SECRET is not set — refusing to send");
    return json(500, { error: "Hook secret not configured." });
  }
  if (!(await signatureValid(req, raw))) {
    console.error("rejected unsigned or mis-signed hook call");
    return json(401, { error: "Invalid signature." });
  }

  let body: {
    user?: { email?: string };
    email_data?: { token_hash?: string; redirect_to?: string; email_action_type?: string };
  };
  try {
    body = JSON.parse(raw);
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
