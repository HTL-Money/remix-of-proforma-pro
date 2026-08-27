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
    // $770,250 is the golden net for this scenario now that correspondent core
    // is active by default: $945,000 gross (6M FHA @2.75% broker + 21M VA/Conv
    // and 3M Non-QM @3.25% core) x the 85% band, less $33,000 of per-file fees
    // (20 broker @$650 + 80 core @$250). It was $633,250 when every file was
    // quoted broker-only.
    for (const s of ["Production", "Production Buckets", "LO Economics", "Your Gain at Hometown Lending", "$770,250", "NMLS 123456"]) {
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

  it("suppresses the gain banner (the image carries the gain bubble) but keeps the text sections", () => {
    // The comparison visual has its own gold gain bubble — a second banner
    // repeating the number directly beneath it reads as shouting. The detail
    // rows below stay as the image-blocked/text fallback.
    expect(withChart).not.toContain("Your Gain at Hometown Lending");
    for (const s of ["Production Buckets", "LO Economics", BRANDING_LINE]) {
      expect(withChart).toContain(s);
    }
  });

  it("keeps the gain banner when NO image rides along (text-only email)", () => {
    const plain = renderRecapHtml(p);
    expect(plain).toContain("Your Gain at Hometown Lending");
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

describe("renderRecapHtml — Documented Pro Forma (delivered as an attachment, never a link)", () => {
  const s = goldenState();
  const p = buildRecapPayload("Jordan — 90%", s, calculate(s));
  const FILE = "Documented-Pro-Forma.pdf";

  it("never emits a /r presentation link, even when appOrigin is set — the deck is attached, not linked", () => {
    const out = renderRecapHtml(p, { appOrigin: "https://app.example.com" });
    expect(out).not.toContain("/r?d=");
    expect(out).not.toContain("View Your Presentation");
  });

  it("omits the Documented Pro Forma block when no PDF is attached — the email must not name a file that isn't there", () => {
    const out = renderRecapHtml(p, { appOrigin: "https://app.example.com" });
    expect(out).not.toContain("Documented Pro Forma");
    expect(out).not.toContain(FILE);
  });

  it("names the attached file in a closing block when a PDF rode along", () => {
    const out = renderRecapHtml(p, { documentedProformaName: FILE });
    expect(out).toContain("Documented Pro Forma");
    expect(out).toContain(FILE);
  });

  it("places the Documented Pro Forma block at the end of the body — after the numbers, before the footer", () => {
    const out = renderRecapHtml(p, { documentedProformaName: FILE, bookingUrl: "https://book.example.com" });
    const economics = out.indexOf("LO Economics");
    const block = out.indexOf("Documented Pro Forma");
    const footer = out.indexOf("All figures are illustrative");
    expect(economics).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(economics);
    expect(block).toBeLessThan(footer);
  });

  it("escapes the filename rather than trusting it as markup", () => {
    const out = renderRecapHtml(p, { documentedProformaName: '<script>x</script>.pdf' });
    expect(out).not.toContain("<script>x</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("still renders the framing headline, which no longer depends on appOrigin", () => {
    const out = renderRecapHtml(p, {});
    expect(out).toContain("Your Personalized Pro Forma");
    expect(out).toContain("leaving money on the table");
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

describe("renderRecapHtml — the personalized opening paragraph", () => {
  const payload = () => {
    const s = goldenState();
    return buildRecapPayload("Jane — 90%", s, calculate(s));
  };

  it("renders the paragraph when present", () => {
    const html = renderRecapHtml(
      { ...payload(), narrative: "You are already producing at a level most desks never reach." },
      {},
    );
    expect(html).toContain("You are already producing at a level most desks never reach.");
  });

  it("omits the block entirely when absent — no empty box, no stray padding", () => {
    const html = renderRecapHtml(payload(), {});
    expect(html).not.toContain("font-size:15px;line-height:1.65");
  });

  // This text is model output. It is data, never markup.
  it("escapes HTML so generated text cannot inject markup into the email", () => {
    const html = renderRecapHtml(
      { ...payload(), narrative: '<script>alert(1)</script> & "quoted"' },
      {},
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  // The whole point of keeping figures out of the paragraph: adding it must not
  // be able to move a single number in the email.
  it("leaves every figure in the email untouched", () => {
    const p = payload();
    const withNarrative = renderRecapHtml({ ...p, narrative: "A plain opening line." }, {});
    const without = renderRecapHtml(p, {});
    const figures = (html: string) => html.match(/\$[\d,]+/g) ?? [];
    expect(figures(withNarrative)).toEqual(figures(without));
    expect(figures(without).length).toBeGreaterThan(0);
  });
});

describe("renderRecapHtml — CAN-SPAM footer honesty", () => {
  const p = () => buildRecapPayload("Jane — 90%", goldenState(), calculate(goldenState()));

  // The old copy claimed a recap "was requested for you" on EVERY send, which
  // was false for the 53 recruiter-initiated ones. A false statement about why a
  // commercial email arrived is the thing CAN-SPAM's deception rules cover.
  it("never claims the recipient requested it when a recruiter initiated the send", () => {
    const html = renderRecapHtml(p(), { origin: "recruiter" });
    expect(html).not.toContain("was requested for you");
    expect(html).not.toMatch(/you requested/i);
    expect(html).toContain("You did not request it");
    expect(html).toContain("public NMLS licensing record");
    expect(html).toContain("recruiting outreach");
  });

  it("says the recipient requested it on a self-serve send", () => {
    const html = renderRecapHtml(p(), { origin: "requested" });
    expect(html).toMatch(/you requested a Pro Forma recap/i);
    expect(html).not.toContain("You did not request it");
  });

  it("keeps the postal address and company NMLS on both paths", () => {
    for (const origin of ["recruiter", "requested"] as const) {
      const html = renderRecapHtml(p(), { origin });
      expect(html).toContain(COMPANY.address);
      expect(html).toContain(COMPANY.nmls);
    }
  });

  it("links the HTTPS one-click URL when given one, and never leaves a bare mailto alongside it", () => {
    const url = "https://x.supabase.co/functions/v1/unsubscribe?t=abc.def";
    const html = renderRecapHtml(p(), { origin: "recruiter", unsubscribeUrl: url });
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain(`href="mailto:${UNSUBSCRIBE_EMAIL}?subject=Unsubscribe"`);
  });

  it("falls back to the mailto when no URL is configured — always a working opt-out", () => {
    const html = renderRecapHtml(p(), { origin: "recruiter" });
    expect(html).toContain(`mailto:${UNSUBSCRIBE_EMAIL}`);
  });

  it("escapes the unsubscribe URL so it can't break out of the href", () => {
    const html = renderRecapHtml(p(), { unsubscribeUrl: 'https://x.test/"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("renderRecapHtml — overridden split wording", () => {
  const p = () => buildRecapPayload("Jane — 90%", goldenState(), calculate(goldenState()));

  it("marks an overridden split as agreed for this offer", () => {
    const html = renderRecapHtml({ ...p(), loSplit: 90, splitSource: "override", derivedSplit: 85 }, {});
    expect(html).toContain("90/10 — you keep 90% (agreed for this offer)");
  });

  it("says nothing extra on a derived split — today's behaviour unchanged", () => {
    const html = renderRecapHtml(p(), {});
    expect(html).not.toContain("agreed for this offer");
  });

  it("treats a payload predating the feature as derived", () => {
    const legacy = { ...p() };
    delete legacy.splitSource;
    expect(renderRecapHtml(legacy, {})).not.toContain("agreed for this offer");
  });
});
