import { describe, it, expect } from "vitest";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";
import type { ModelState } from "@/lib/proforma";
import { stackHeights, VAULT_PHASES, VAULT_DURATION } from "@/lib/vaultAnimation";
import { renderVaultGif, vaultParamsFromRecap } from "@/lib/vaultGif";
import { buildRecapDocx } from "@/lib/recapDocx";
import { renderRecapHtml, GIF_CID } from "../../supabase/functions/send-recap/template";

const goldenState = (): ModelState => ({
  ...defaultState(),
  recruitName: "Jane Smith",
  nmls: "123456",
  annualVolume: 30_000_000,
  annualFiles: 100,
  avgLoanAmount: 300_000,
  currentSplit: 2.0, // 200 BPS
});

const payload = (over: Partial<ModelState> = {}) => {
  const s = { ...goldenState(), ...over };
  return buildRecapPayload("Jane — 90%", s, calculate(s));
};

describe("stackHeights — the ≥25% visible difference rule", () => {
  it("equal amounts render equal heights", () => {
    const h = stackHeights(200_000, 200_000);
    expect(h.currentH).toBe(h.htlH);
  });

  it("near-equal (rounding noise) also renders equal", () => {
    const h = stackHeights(200_000, 200_400); // 0.2% apart
    expect(h.currentH).toBe(h.htlH);
  });

  it("a small real gain is stretched to at least 25% visual difference", () => {
    const h = stackHeights(100_000, 110_000); // only 10% more
    expect(h.htlH / h.currentH).toBeGreaterThanOrEqual(1.25);
  });

  it("an honest mid-range ratio is preserved as-is", () => {
    const h = stackHeights(182_000, 312_500); // 1.717x
    expect(h.htlH / h.currentH).toBeCloseTo(312_500 / 182_000, 2);
  });

  it("extreme ratios are compressed so both piles stay in frame", () => {
    const h = stackHeights(50_000, 1_000_000); // 20x
    expect(h.htlH / h.currentH).toBeLessThanOrEqual(3.0);
    expect(h.currentH).toBeGreaterThanOrEqual(18);
  });

  it("mirrors the rule when current out-earns HTL", () => {
    const h = stackHeights(300_000, 250_000);
    expect(h.currentH / h.htlH).toBeGreaterThanOrEqual(1.25);
  });

  it("handles zeros and garbage without NaN", () => {
    for (const [c, h] of [
      [0, 0],
      [0, 250_000],
      [250_000, 0],
      [NaN, 250_000],
      [250_000, Infinity],
    ] as const) {
      const r = stackHeights(c, h);
      expect(Number.isFinite(r.currentH)).toBe(true);
      expect(Number.isFinite(r.htlH)).toBe(true);
      expect(r.currentH).toBeGreaterThan(0);
      expect(r.htlH).toBeGreaterThan(0);
    }
  });
});

describe("VAULT_PHASES — the 10-second beat sheet", () => {
  it("keeps the locked story order: stack → descent → impact → pile → card → end", () => {
    const T = VAULT_PHASES;
    expect(T.stackDone).toBeLessThan(T.descentStart);
    expect(T.descentStart).toBeLessThan(T.impact);
    expect(T.impact).toBeLessThan(T.pileDone);
    expect(T.pileDone).toBeLessThan(T.cardStart);
    expect(T.cardStart).toBeLessThan(T.end);
    expect(T.end).toBe(VAULT_DURATION);
  });
});

describe("vaultParamsFromRecap — same eligibility as the chart", () => {
  it("builds params (with formatted labels) when a comparison exists", () => {
    const p = vaultParamsFromRecap(payload());
    expect(p).not.toBeNull();
    expect(p!.currentAnnual).toBeGreaterThan(0);
    expect(p!.htlAnnual).toBeGreaterThan(0);
    expect(p!.currentLabel).toMatch(/^\$[\d,]+$/);
    expect(p!.htlLabel).toMatch(/^\$[\d,]+$/);
  });

  it("returns null with no current-platform comp — no comparison, no story", () => {
    expect(vaultParamsFromRecap(payload({ currentSplit: null }))).toBeNull();
  });
});

describe("renderVaultGif in a canvas-less DOM", () => {
  it("returns null instead of throwing (jsdom has no 2d context)", () => {
    const p = vaultParamsFromRecap(payload())!;
    expect(renderVaultGif(p)).toBeNull();
  });
});

describe("buildRecapDocx", () => {
  it("produces real .docx bytes (ZIP magic, plausible size)", async () => {
    const bytes = await buildRecapDocx(payload());
    expect(bytes).not.toBeNull();
    // PK\x03\x04 — a .docx is a ZIP container
    expect(Array.from(bytes!.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes!.byteLength).toBeGreaterThan(2_000);
    expect(bytes!.byteLength).toBeLessThan(1_000_000); // inside the server-side cap
  });
});

describe("renderRecapHtml — vault hero block", () => {
  it("renders the hero img when gifCid is provided", () => {
    const html = renderRecapHtml(payload(), { gifCid: GIF_CID });
    expect(html).toContain(`cid:${GIF_CID}`);
    expect(html).toContain('width="600" height="338"');
  });

  it("omits the hero entirely when gifCid is unset", () => {
    const html = renderRecapHtml(payload());
    expect(html).not.toContain("cid:vault-hero");
  });

  it("HTML-escapes nothing dangerous into the hero alt text", () => {
    const html = renderRecapHtml(payload(), { gifCid: GIF_CID });
    const alt = /alt="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(alt).toContain("bank vault");
    expect(alt).not.toContain("<");
  });
});
