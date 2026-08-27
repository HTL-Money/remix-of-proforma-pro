import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildRecapDocx } from "@/lib/recapDocx";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";

const state = () => ({
  ...defaultState(),
  recruitName: "Jane Smith",
  nmls: "123456",
  annualVolume: 30_000_000,
  annualFiles: 100,
  avgLoanAmount: 300_000,
  currentSplit: 2.0,
});

/** The document's visible text, pulled out of the zipped XML. */
const docxText = async (bytes: Uint8Array): Promise<string> => {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  return xml.replace(/<[^>]+>/g, " ");
};

describe("buildRecapDocx — the split footnote tells the truth", () => {
  it("states the tier table on a derived split", async () => {
    const bytes = await buildRecapDocx(buildRecapPayload("Jane", state(), calculate(state())));
    const text = await docxText(bytes!);
    expect(text).toContain("Bands are set by monthly funded volume");
    expect(text).not.toContain("terms discussed for this offer");
  });

  // On an overridden split the tier-table sentence would contradict the number
  // beside it — the doc must say what is true instead.
  it("drops the tier table and says the split was agreed, when overridden", async () => {
    const p = { ...buildRecapPayload("Jane", state(), calculate(state())), loSplit: 90, splitSource: "override" as const, derivedSplit: 85 };
    const text = await docxText((await buildRecapDocx(p))!);
    expect(text).not.toContain("Bands are set by monthly funded volume");
    expect(text).toContain("terms discussed for this offer rather than the standard volume tiers");
    expect(text).toContain("90/10 split");
  });

  it("keeps the illustrative disclaimer on both paths", async () => {
    for (const splitSource of ["derived", "override"] as const) {
      const p = { ...buildRecapPayload("Jane", state(), calculate(state())), splitSource };
      const text = await docxText((await buildRecapDocx(p))!);
      expect(text).toContain("not an offer of employment or compensation");
    }
  });
});
