import { describe, it, expect } from "vitest";
import {
  COMPANY_FOOTER,
  INVITE_SUBJECT,
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
