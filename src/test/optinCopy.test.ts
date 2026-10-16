import { describe, it, expect } from "vitest";
import {
  COMPANY_FOOTER,
  CONSENT_NOTICE_SUBJECT,
  INVITE_SUBJECT,
  renderConsentConfirmHtml,
  renderConsentNoticeHtml,
  renderExpiredHtml,
  renderInviteHtml,
} from "../../supabase/functions/recruit-optin/copy";

const facts = () => ({
  recruitName: "Jane Smith",
  loName: "Chris",
  loEmail: "chrisc@hometownlend.com",
  consentUrl: "https://x.supabase.co/functions/v1/recruit-optin?t=abc123",
  unsubscribeUrl: "https://x.supabase.co/functions/v1/unsubscribe?t=tok.sig",
});

describe("the opt-in invitation — figure-free by construction", () => {
  const html = renderInviteHtml(facts());

  // The recap carries the income representations; this email must carry NONE.
  // Checked on the VISIBLE text (CSS is full of width:100%), and the ban is on
  // money and percentages, not digits — the CAN-SPAM footer's NMLS number and
  // street address are digits and required.
  const visibleText = (h: string) => h.replace(/<[^>]*>/g, " ");
  it("shows the reader no dollar figure and no percentage", () => {
    const text = visibleText(html);
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/\d\s*%/);
    expect(text).not.toMatch(/\bpercent\b/i);
    expect(INVITE_SUBJECT).not.toMatch(/[$%]/);
  });

  it("carries the owner-approved key sentences", () => {
    expect(html).toContain("I haven't sent you the numbers, because you didn't ask for them.");
    expect(html).toContain("public NMLS licensing records");
    expect(html).toContain("no call or commitment attached");
    expect(html).toContain("Show me my comparison");
  });

  it("is honest about being outreach, with a working opt-out", () => {
    expect(html).toContain("This is recruiting outreach — you did not request this email.");
    expect(html).toContain(`href="${facts().unsubscribeUrl}"`);
  });

  it("carries the CAN-SPAM identity block", () => {
    expect(html).toContain(COMPANY_FOOTER.address);
    expect(html).toContain(`NMLS #${COMPANY_FOOTER.nmls}`);
  });

  it("links the consent URL and routes replies to the inviting LO", () => {
    expect(html).toContain(`href="${facts().consentUrl}"`);
    expect(html).toContain("chrisc@hometownlend.com");
  });

  it("escapes a hostile recruit name", () => {
    const out = renderInviteHtml({ ...facts(), recruitName: '<script>alert(1)</script>' });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("greets generically when no name is known — never 'Hi null'", () => {
    for (const recruitName of [null, undefined, "", "   "]) {
      expect(renderInviteHtml({ ...facts(), recruitName })).toContain("Hi —");
    }
  });
});

describe("the expired-link page", () => {
  it("never says 'invalid token' and always offers the calculator", () => {
    const html = renderExpiredHtml("https://htlrecruit.broker");
    expect(html.toLowerCase()).not.toContain("invalid");
    expect(html.toLowerCase()).not.toContain("token");
    expect(html).toContain('href="https://htlrecruit.broker"');
  });
});

describe("the consent confirmation page — a button, not a side effect", () => {
  const html = renderConsentConfirmHtml({
    actionUrl: "https://x.supabase.co/functions/v1/recruit-optin",
    token: "0123456789abcdef0123456789abcdef",
    appOrigin: "https://htlrecruit.broker",
  });
  const visibleText = (h: string) => h.replace(/<[^>]*>/g, " ");

  it("posts the consent action with the token — scanners follow GETs, never submit forms", () => {
    expect(html).toContain('<form method="post" action="https://x.supabase.co/functions/v1/recruit-optin"');
    expect(html).toContain('<input type="hidden" name="action" value="consent" />');
    expect(html).toContain('<input type="hidden" name="t" value="0123456789abcdef0123456789abcdef" />');
    expect(html).toContain("Show me my comparison");
  });

  it("shows no dollar figure and no percentage", () => {
    const text = visibleText(html);
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/\d\s*%/);
  });

  it("says plainly what pressing the button records", () => {
    expect(html).toContain("Pressing the button is you asking to see it");
  });

  it("escapes a hostile token", () => {
    const out = renderConsentConfirmHtml({ actionUrl: "https://x", token: '"><script>', appOrigin: "https://x" });
    expect(out).not.toContain('"><script>');
  });
});

describe("the consent notice to the inviting LO", () => {
  const html = renderConsentNoticeHtml({ recruitEmail: "jane@example.com", recruitName: "Jane", nmls: "123456", linksUrl: "https://htlrecruit.broker/links" });

  it("names the recruit and the NMLS, and links the Links page", () => {
    expect(html).toContain("Jane (jane@example.com)");
    expect(html).toContain("NMLS 123456");
    expect(html).toContain('href="https://htlrecruit.broker/links"');
    expect(CONSENT_NOTICE_SUBJECT).not.toMatch(/[$%]/);
  });

  it("carries no figures — the LO sees those in the app", () => {
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/\d\s*%/);
  });

  it("escapes a hostile name", () => {
    const out = renderConsentNoticeHtml({ recruitEmail: "j@x.com", recruitName: "<img src=x onerror=1>", nmls: "1", linksUrl: "https://x" });
    expect(out).not.toContain("<img src=x");
  });
});
