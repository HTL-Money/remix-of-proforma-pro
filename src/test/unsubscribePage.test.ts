import { describe, it, expect } from "vitest";
import {
  renderUnsubscribeConfirmHtml,
  renderUnsubscribeErrorHtml,
  renderUnsubscribedHtml,
} from "../../supabase/functions/unsubscribe/page";

const ACTION = "https://x.supabase.co/functions/v1/unsubscribe";
const TOKEN = "abc.def";

describe("unsubscribe confirmation page — the GET that writes nothing", () => {
  const html = renderUnsubscribeConfirmHtml(ACTION, TOKEN);

  it("asks before acting, with a POST form carrying the token", () => {
    expect(html).toMatch(/<form[^>]*method="post"/i);
    expect(html).toContain(`action="${ACTION}?t=${encodeURIComponent(TOKEN)}"`);
    expect(html).toContain(`<input type="hidden" name="t" value="${TOKEN}" />`);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Unsubscribe<\/button>/);
  });

  it("tells the reader nothing changes until they press the button", () => {
    expect(html).toContain("nothing changes until you press it");
  });

  it("renders identically for any token — validity is never revealed on GET", () => {
    const a = renderUnsubscribeConfirmHtml(ACTION, "valid.token").replace(/valid\.token/g, "X");
    const b = renderUnsubscribeConfirmHtml(ACTION, "garbage").replace(/garbage/g, "X");
    expect(a).toBe(b);
  });

  it("escapes a hostile token so it cannot break out of the form", () => {
    const out = renderUnsubscribeConfirmHtml(ACTION, '"><script>alert(1)</script>');
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("is kept out of search engines", () => {
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });
});

describe("unsubscribed page — the POST result", () => {
  it("confirms the address when the write succeeded", () => {
    expect(renderUnsubscribedHtml("jane@example.com")).toContain("<strong>jane@example.com</strong> has been removed");
  });

  it("never says 'invalid token' — a bad token reads exactly like success", () => {
    const out = renderUnsubscribedHtml(null);
    expect(out).toContain("You're unsubscribed");
    expect(out).not.toMatch(/invalid/i);
    expect(out).not.toMatch(/token/i);
  });

  it("escapes the echoed address", () => {
    expect(renderUnsubscribedHtml("<b>x</b>@example.com")).not.toContain("<b>x</b>");
  });

  it("the error page offers a human fallback", () => {
    expect(renderUnsubscribeErrorHtml()).toContain("marketing@hometownlend.com");
  });
});
