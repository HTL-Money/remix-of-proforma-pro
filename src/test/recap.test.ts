import { describe, it, expect } from "vitest";
import { buildRecapPayload, isValidEmail } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";
import { renderRecapHtml, BRANDING_LINE } from "../../supabase/functions/send-recap/template";

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

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("jamesm@hometownlend.com")).toBe(true);
    expect(isValidEmail(" someone@sub.domain.co ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});
