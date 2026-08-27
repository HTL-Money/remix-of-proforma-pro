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
