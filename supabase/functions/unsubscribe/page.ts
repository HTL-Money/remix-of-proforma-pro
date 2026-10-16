// The unsubscribe endpoint's pages. Pure (no Deno globals) so vitest can pin
// the one property that matters: the footer link's GET renders a page with a
// button, and only the button's POST writes anything.
//
// Why: 69 of 69 suppressions on this project arrived via the GET link, 13 of
// them under two minutes after delivery and several at 0 minutes — corporate
// link scanners (Safe Links, Proofpoint) following every URL in the email.
// A GET that mutates state is exactly what RFC 8058 warns about. One-click
// clients POST, humans press the button; nothing else unsubscribes anyone.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const shell = (title: string, inner: string): string =>
  `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title></head>
<body style="margin:0;background:#13294B;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
<div style="max-width:520px;margin:12vh auto;padding:32px 28px;background:#fff;border-radius:12px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#13294B;">${esc(title)}</h1>
${inner}
</div></body></html>`;

/** GET: ask before acting. The token rides in a hidden field AND in the form's
 *  action query so the POST handler has one code path for both the button and
 *  RFC 8058 one-click clients. Renders the same page whether or not the token
 *  is valid — validity is only ever revealed by what the POST does. */
export const renderUnsubscribeConfirmHtml = (actionUrl: string, token: string): string =>
  shell(
    "Unsubscribe from Hometown Lending emails?",
    `<p style="margin:0 0 18px;color:#4a4a4a;font-size:15px;line-height:1.6;">Press the button and you won't receive further pro forma emails from Hometown Lending. If you got here by accident, just close this page — nothing changes until you press it.</p>
<form method="post" action="${esc(actionUrl)}?t=${encodeURIComponent(token)}" style="margin:0;">
<input type="hidden" name="t" value="${esc(token)}" />
<button type="submit" style="display:inline-block;padding:12px 26px;background:#4F8F77;border:0;border-radius:8px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;">Unsubscribe</button>
</form>`,
  );

/** POST result. Deliberately the same page for an invalid token: a recipient
 *  who clicked unsubscribe must never read "invalid token" (it reads as "we're
 *  still going to email you") and it would leak whether an address is on file. */
export const renderUnsubscribedHtml = (email: string | null): string =>
  shell(
    "You're unsubscribed",
    `<p style="margin:0;color:#4a4a4a;font-size:15px;line-height:1.6;">${
      email
        ? `<strong>${esc(email)}</strong> has been removed. You won't receive further pro forma emails from Hometown Lending.`
        : "You won't receive further pro forma emails from Hometown Lending. If anything still arrives, reply to it and we'll sort it out."
    }</p>`,
  );

export const renderUnsubscribeErrorHtml = (): string =>
  shell(
    "Something went wrong",
    `<p style="margin:0;color:#4a4a4a;font-size:15px;line-height:1.6;">We couldn't process that just now. Email marketing@hometownlend.com and we'll remove you by hand.</p>`,
  );
