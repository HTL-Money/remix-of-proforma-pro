// The opt-in invitation — the one email an LO may send to a recruit who hasn't
// asked for anything yet. Pure module (no Deno globals) so vitest enforces the
// rules directly, same convention as narrativePrompt.ts and template.ts.
//
// The entire point of this email is what it DOESN'T contain: no dollar
// figures, no percentages, no comp claims. The recap carries the income
// representations, and the recap now only goes to someone who clicked. This
// invitation must survive being read by a hostile recipient, their current
// manager, and a regulator, in that order. Copy approved by the owner
// verbatim; change it only with their sign-off.

export interface InviteFacts {
  recruitName?: string | null;
  /** The inviting LO — replies go to them, and the email is signed by them. */
  loName: string;
  loEmail: string;
  /** The consent link: recruit-optin's consent route with this invite's token. */
  consentUrl: string;
  /** One-click unsubscribe URL for this recipient (never a bare mailto). */
  unsubscribeUrl: string;
}

export const COMPANY_FOOTER = {
  name: "HomeTown Lending",
  nmls: "2712965",
  address: "5050 Quorum Drive, Ste. 600, Dallas, TX 75254",
} as const;

export const INVITE_SUBJECT = "Your production vs. our split — want to see it?";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const renderInviteHtml = (f: InviteFacts): string => {
  const NAVY = "#13294B", MINT = "#6FBF9E", GREEN = "#4F8F77", GRAY = "#7a7a7a";
  const greeting = f.recruitName?.trim() ? `${esc(f.recruitName.trim())} —` : "Hi —";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 8px;"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
      <tr><td style="background:${NAVY};padding:26px 24px;text-align:center;">
        <div style="color:${MINT};font-size:26px;font-weight:800;font-family:Georgia,'Times New Roman',serif;">Hometown Lending</div>
      </td></tr>
      <tr><td style="padding:28px 28px 0 28px;color:#333;font-size:15px;line-height:1.7;">
        <p style="margin:0 0 14px 0;">${greeting}</p>
        <p style="margin:0 0 14px 0;">I'm ${esc(f.loName)} with Hometown Lending. I looked up your funded production in the public NMLS licensing records and built a side-by-side of what that same volume would pay on our split.</p>
        <p style="margin:0 0 14px 0;font-weight:700;color:${NAVY};">I haven't sent you the numbers, because you didn't ask for them.</p>
        <p style="margin:0 0 14px 0;">If you want to see it, the link below opens your comparison with your figures already filled in. Nothing is shared with anyone, and there's no call or commitment attached.</p>
      </td></tr>
      <tr><td align="center" style="padding:8px 28px 6px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:${GREEN};border-radius:8px;">
          <a href="${esc(f.consentUrl)}" target="_blank" style="display:inline-block;padding:14px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Show me my comparison</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:14px 28px 24px 28px;color:${GRAY};font-size:13px;line-height:1.6;">
        If you'd rather I didn't contact you again, use the unsubscribe link below and I won't.
      </td></tr>
      <tr><td style="padding:0 28px 22px 28px;">
        <div style="border-top:1px solid #e6e6e6;padding-top:14px;color:${GRAY};font-size:12px;">
          ${esc(f.loName)} · Hometown Lending · <a href="mailto:${esc(f.loEmail)}" style="color:${GREEN};text-decoration:none;">${esc(f.loEmail)}</a>
        </div>
      </td></tr>
      <tr><td style="background:${NAVY};padding:18px 24px;text-align:center;">
        <div style="color:#9fb1c8;font-size:11px;line-height:1.6;">
          ${COMPANY_FOOTER.name} · NMLS #${COMPANY_FOOTER.nmls}<br />
          ${COMPANY_FOOTER.address}<br />
          This is recruiting outreach — you did not request this email.
          <a href="${esc(f.unsubscribeUrl)}" style="color:#9fb1c8;text-decoration:underline;">Unsubscribe</a>
        </div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
};

/** The consent-confirmed landing is a redirect; this page renders only when a
 *  token is invalid or already lapsed. Like the unsubscribe page, it never
 *  says "invalid token" — it offers the calculator instead. */
export const renderExpiredHtml = (appOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /><title>Hometown Lending</title></head>
<body style="margin:0;background:#13294B;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
<div style="max-width:520px;margin:12vh auto;padding:32px 28px;background:#fff;border-radius:12px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#13294B;">That link has expired</h1>
<p style="margin:0 0 16px;color:#4a4a4a;font-size:15px;line-height:1.6;">No problem — you can run your own comparison any time, no link needed.</p>
<a href="${esc(appOrigin)}" style="display:inline-block;padding:12px 26px;background:#4F8F77;border-radius:8px;color:#fff;font-weight:700;text-decoration:none;font-size:15px;">Open the calculator</a>
</div></body></html>`;

/** The page behind the invite's link. Nothing is recorded by opening it:
 *  corporate link scanners follow every URL in a delivered email (three of the
 *  first ten "consents" on this project arrived between midnight and 4 a.m.
 *  from the same employer's mail gateway), so consent is only recorded when
 *  the button below is pressed — a POST, which scanners never send. */
export const renderConsentConfirmHtml = (f: { actionUrl: string; token: string; appOrigin: string }): string =>
  `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex" />
<title>Hometown Lending</title></head>
<body style="margin:0;background:#13294B;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
<div style="max-width:520px;margin:12vh auto;padding:32px 28px;background:#fff;border-radius:12px;">
<div style="color:#4F8F77;font-size:22px;font-weight:800;font-family:Georgia,'Times New Roman',serif;margin:0 0 14px;">Hometown Lending</div>
<h1 style="margin:0 0 12px;font-size:20px;color:#13294B;">Your comparison is one click away</h1>
<p style="margin:0 0 10px;color:#4a4a4a;font-size:15px;line-height:1.6;">It opens with your funded production from the public NMLS records already filled in, side by side with what the same volume pays on our split. Nothing is shared with anyone, and there's no call or commitment attached.</p>
<p style="margin:0 0 18px;color:#4a4a4a;font-size:15px;line-height:1.6;">Pressing the button is you asking to see it — that's the only thing it records.</p>
<form method="post" action="${esc(f.actionUrl)}" style="margin:0;">
<input type="hidden" name="action" value="consent" />
<input type="hidden" name="t" value="${esc(f.token)}" />
<button type="submit" style="display:inline-block;padding:13px 30px;background:#4F8F77;border:0;border-radius:8px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;">Show me my comparison</button>
</form>
<p style="margin:18px 0 0;color:#7a7a7a;font-size:13px;line-height:1.6;">Changed your mind? Just close this page. You can also run your own comparison any time at <a href="${esc(f.appOrigin)}" style="color:#4F8F77;">${esc(f.appOrigin.replace(/^https?:\/\//, ""))}</a>.</p>
</div></body></html>`;

export const CONSENT_NOTICE_SUBJECT = "Your recruit opened their comparison";

/** To the INVITING LO, the moment their recruit confirms. Figure-free: the LO
 *  sees the numbers in the app, this is just the nudge to follow up — until
 *  now nobody was told, and no consent was ever followed by a send. */
export const renderConsentNoticeHtml = (f: { recruitEmail: string; recruitName?: string | null; nmls: string; linksUrl: string }): string => {
  const who = f.recruitName?.trim() ? `${esc(f.recruitName.trim())} (${esc(f.recruitEmail)})` : esc(f.recruitEmail);
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;color:#333;font-size:15px;line-height:1.7;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:24px 28px;">
<p style="margin:0 0 12px;"><strong>${who}</strong> just opened their comparison — NMLS ${esc(f.nmls)}.</p>
<p style="margin:0 0 12px;">That's their opt-in: the pro forma is unlocked for ${CONSENT_MONTHS_LABEL}, and they're looking at it right now. A same-day follow-up is the whole game here.</p>
<p style="margin:0 0 16px;"><a href="${esc(f.linksUrl)}" style="display:inline-block;padding:11px 22px;background:#4F8F77;border-radius:8px;color:#fff;font-weight:700;text-decoration:none;">Open the Links page</a></p>
<p style="margin:0;color:#7a7a7a;font-size:12px;">Automatic notice from ProFarmA. Replies to this message go nowhere useful — reply to the recruit instead.</p>
</div></body></html>`;
};

const CONSENT_MONTHS_LABEL = "12 months";
