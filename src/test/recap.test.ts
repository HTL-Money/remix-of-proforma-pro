import { describe, it, expect } from "vitest";
import { buildRecapPayload, isValidEmail } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";
import { renderRecapHtml, BRANDING_LINE, CHART_CID, RECRUITER, COMPANY, UNSUBSCRIBE_EMAIL } from "../../supabase/functions/send-recap/template";
import { decodeRecap } from "@/lib/recapLink";

const goldenState = () => ({
  ...defaultState(),
  recruitName: "Jane Smith",
  nmls: "123456",
  annualVolume: 30_000_000,
  annualFiles: 100,
  avgLoanAmount: 300_000,
  currentSplit: 2.0, // 200 BPS
});

describe("buildRecapPayload", () => {
  it("captures the numbers the email needs", () => {
    const s = goldenState();
    const calc = calculate(s);
    const p = buildRecapPayload("Jane — 90%", s, calc, "pf-1");
    expect(p.savedName).toBe("Jane — 90%");
    expect(p.loName).toBe("Jane Smith");
    expect(p.currentBps).toBe(200);
    expect(p.htl.annual).toBeCloseTo(calc.finalLoNetComp, 2);
    expect(p.current.annual).toBeCloseTo(calc.currentPlatformAnnual!, 2);
    expect(p.gain.annual).toBeCloseTo(calc.diffAnnual!, 2);
    expect(p.buckets.length).toBeGreaterThan(0);
    expect(p.proformaId).toBe("pf-1");
  });

  it("handles a null current split (no comparison)", () => {
    const s = { ...goldenState(), currentSplit: null };
    const p = buildRecapPayload("x", s, calculate(s));
    expect(p.currentBps).toBeNull();
    expect(p.current.annual).toBeNull();
    expect(p.gain.annual).toBeNull();
  });
});

describe("renderRecapHtml", () => {
  const html = renderRecapHtml(buildRecapPayload("Jane — 90%", goldenState(), calculate(goldenState())));

  it("includes the branding line", () => {
    expect(html).toContain("Hometown Lending: Your True Value Awaits.");
    expect(BRANDING_LINE).toBe("Hometown Lending: Your True Value Awaits.");
  });

  it("shows current earnings in grayscale on the left and a larger colored HTL amount on the right", () => {
    const currentIdx = html.indexOf("Current Platform");
    const htlIdx = html.indexOf("font-size:40px");
    expect(currentIdx).toBeGreaterThan(-1);
    expect(htlIdx).toBeGreaterThan(currentIdx); // current column renders first (left)
    // Current side uses gray tones and a smaller amount
    expect(html).toContain("font-size:26px"); // current amount, smaller
    expect(html.slice(currentIdx, htlIdx)).toContain("#4a4a4a"); // grayscale amount color
    // HTL side uses brand colors
    expect(html).toContain("#13294B"); // navy
    expect(html).toContain("#6FBF9E"); // mint amount color
  });

  it("shows the full content: production, buckets, economics, gain", () => {
    for (const s of ["Production", "Production Buckets", "LO Economics", "Your Gain at Hometown Lending", "$674,500", "NMLS 123456"]) {
      expect(html).toContain(s);
    }
  });

  it("escapes HTML in user-controlled strings", () => {
    const s = { ...goldenState(), recruitName: `<img src=x onerror=alert(1)>` };
    const out = renderRecapHtml(buildRecapPayload("x<script>", s, calculate(s)));
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("x<script>");
    expect(out).toContain("&lt;img");
  });

  it("omits the comparison/gain when no current split was entered", () => {
    const s = { ...goldenState(), currentSplit: null };
    const out = renderRecapHtml(buildRecapPayload("x", s, calculate(s)));
    expect(out).toContain("No current-platform comp entered");
    expect(out).not.toContain("Your Gain at Hometown Lending");
  });
});

describe("renderRecapHtml with an inline chart image", () => {
  const p = buildRecapPayload("Jane — 90%", goldenState(), calculate(goldenState()));
  const withChart = renderRecapHtml(p, { chartCid: CHART_CID });
  const usd = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  it("embeds the CID image in place of the HTML comparison cells", () => {
    expect(withChart).toContain(`src="cid:${CHART_CID}"`);
    expect(withChart).toContain('width="600"');
    expect(withChart).not.toContain("font-size:40px"); // HTML HTL cell gone
    expect(withChart).not.toContain("#f2f2f2"); // grayscale current cell gone
  });

  it("keeps the gain banner and text sections alongside the image", () => {
    for (const s of ["Your Gain at Hometown Lending", "Production Buckets", "LO Economics", BRANDING_LINE]) {
      expect(withChart).toContain(s);
    }
  });

  it("carries both annual amounts in the alt text for image-blocking clients", () => {
    const alt = /alt="([^"]+)"/.exec(withChart)?.[1] ?? "";
    expect(alt).toContain(usd(p.current.annual ?? 0));
    expect(alt).toContain(usd(p.htl.annual));
  });

  it("renders an HTL-only alt when there is no comparison", () => {
    const s = { ...goldenState(), currentSplit: null };
    const out = renderRecapHtml(buildRecapPayload("x", s, calculate(s)), { chartCid: CHART_CID });
    const alt = /alt="([^"]+)"/.exec(out)?.[1] ?? "";
    expect(alt).toContain("Hometown Lending");
    expect(alt).not.toContain("Current platform");
  });

  it("renders the classic HTML cells when no chart is provided", () => {
    const plain = renderRecapHtml(p, {});
    expect(plain).not.toContain("cid:");
    expect(plain).toContain("font-size:40px");
    expect(plain).toContain("Current Platform");
  });
});

describe("renderRecapHtml booking CTA", () => {
  const s = goldenState();
  const p = buildRecapPayload("x", s, calculate(s));

  it("renders the booking button when a bookingUrl is provided", () => {
    const out = renderRecapHtml(p, { bookingUrl: "https://outlook.office365.com/book/HTL@hometownlend.com/" });
    expect(out).toContain("Book a confidential 15-min walkthrough");
    expect(out).toContain('href="https://outlook.office365.com/book/HTL@hometownlend.com/"');
    expect(out).toContain("No pitch, no commitment");
  });

  it("omits the section entirely when no bookingUrl is set — no dead links", () => {
    const out = renderRecapHtml(p, {});
    expect(out).not.toContain("Book a confidential 15-min walkthrough");
    expect(out).not.toContain("live availability");
  });

  it("escapes a hostile bookingUrl so it can't break out of the href", () => {
    const out = renderRecapHtml(p, { bookingUrl: 'https://x.test/"><script>alert(1)</script>' });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("composes with the inline chart option", () => {
    const out = renderRecapHtml(p, { chartCid: CHART_CID, bookingUrl: "https://x.test/book" });
    expect(out).toContain(`cid:${CHART_CID}`);
    expect(out).toContain("Book a confidential 15-min walkthrough");
  });
});

describe("renderRecapHtml — signature, CAN-SPAM footer, period-aware labels", () => {
  const s = goldenState();
  const html = renderRecapHtml(buildRecapPayload("Jane — 90%", s, calculate(s)));

  it("renders the recruiter signature with reply-worthy contact details", () => {
    expect(html).toContain(RECRUITER.name); // Aryan Jafarzadeh
    expect(html).toContain(RECRUITER.title); // Founder / CEO
    expect(html).toContain(`NMLS #${RECRUITER.nmls}`); // 1989264
    expect(html).toContain(`mailto:${RECRUITER.email}`);
    expect(html).toContain(RECRUITER.phone);
  });

  it("includes a compliant CAN-SPAM footer: company identity, address, unsubscribe", () => {
    expect(html).toContain(`NMLS #${COMPANY.nmls}`); // 2712965
    expect(html).toContain(COMPANY.address);
    expect(html).toContain(`mailto:${UNSUBSCRIBE_EMAIL}?subject=Unsubscribe`);
    expect(html).toContain("not a guarantee of income");
  });

  it("labels production as Annual for a full-year (default) period", () => {
    expect(html).toContain("Annual funded volume");
    expect(html).toContain("Final LO net annual comp");
  });

  it("labels a non-annual pull window honestly — never a false 'Annual'", () => {
    const six = { ...goldenState(), productionPeriodMonths: 6 };
    const out = renderRecapHtml(buildRecapPayload("x", six, calculate(six)));
    expect(out).toContain("Previous Six Months funded volume");
    expect(out).toContain("Previous Six Months funded files");
    expect(out).not.toContain("Annual funded volume");
    expect(out).toContain("Final LO net comp — Previous Six Months");
  });

  it("threads periodMonths into the payload from the calc", () => {
    const six = { ...goldenState(), productionPeriodMonths: 6 };
    expect(buildRecapPayload("x", six, calculate(six)).periodMonths).toBe(6);
    expect(buildRecapPayload("x", goldenState(), calculate(goldenState())).periodMonths).toBe(12);
  });
});

describe("renderRecapHtml — watch-online link (Part K foundation)", () => {
  const s = goldenState();
  const p = buildRecapPayload("Jordan — 90%", s, calculate(s));

  it("omits the link entirely when no appOrigin is set — no dead link", () => {
    const out = renderRecapHtml(p, {});
    expect(out).not.toContain("Watch your personalized recap online");
  });

  it("renders a /r link pointing at the given origin when appOrigin is set", () => {
    const out = renderRecapHtml(p, { appOrigin: "https://app.example.com" });
    expect(out).toContain("Watch your personalized recap online");
    expect(out).toMatch(/href="https:\/\/app\.example\.com\/r\?d=[^"]+"/);
  });

  it("strips a trailing slash on the origin, matching src/lib/recapLink.ts's buildRecapPageUrl", () => {
    const out = renderRecapHtml(p, { appOrigin: "https://app.example.com/" });
    expect(out).toContain('href="https://app.example.com/r?d=');
    expect(out).not.toContain("app.example.com//r");
  });

  it("cross-implementation: the token this Deno-side template builds decodes correctly with the client's recapLink.ts decodeRecap", () => {
    const out = renderRecapHtml(p, { appOrigin: "https://app.example.com" });
    const token = /\/r\?d=([^"]+)"/.exec(out)?.[1] ?? "";
    expect(token.length).toBeGreaterThan(0);
    const decoded = decodeRecap(token);
    expect(decoded).toEqual(p);
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("jamesm@hometownlend.com")).toBe(true);
    expect(isValidEmail(" someone@sub.domain.co ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});
