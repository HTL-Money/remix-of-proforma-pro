import { describe, it, expect } from "vitest";
import {
  ALL_STAGES, STAGES, canAutoAdvance, groupByStage, mergeActivity, pipelineStats, stageIndex, stageLabel,
} from "@/lib/pipeline";
import type { StageKey } from "@/lib/pipeline";

const row = (stage: StageKey, annualVolume = 10_000_000) => ({ stage, annualVolume });

describe("stage model", () => {
  it("keeps the funnel in recruiting order with lost outside it", () => {
    expect(STAGES.map(s => s.key)).toEqual(["target", "contacted", "proforma_sent", "meeting", "offer", "signed"]);
    expect(ALL_STAGES.at(-1)!.key).toBe("lost");
    expect(stageIndex("lost")).toBe(-1);
    expect(stageLabel("proforma_sent")).toBe("Pro Forma Sent");
  });

  it("auto-advance only ever moves forward", () => {
    expect(canAutoAdvance("target", "proforma_sent")).toBe(true);
    expect(canAutoAdvance("contacted", "proforma_sent")).toBe(true);
    expect(canAutoAdvance("proforma_sent", "proforma_sent")).toBe(false); // same stage
    expect(canAutoAdvance("meeting", "proforma_sent")).toBe(false); // backwards
    expect(canAutoAdvance("offer", "proforma_sent")).toBe(false);
  });

  it("auto-advance never pulls recruits out of signed or lost", () => {
    expect(canAutoAdvance("signed", "proforma_sent")).toBe(false);
    expect(canAutoAdvance("lost", "proforma_sent")).toBe(false);
    expect(canAutoAdvance("garbage", "proforma_sent")).toBe(false); // unknown stage stays put
  });
});

describe("pipelineStats", () => {
  it("sums only active recruits into pipeline volume", () => {
    const s = pipelineStats([
      row("target", 20_000_000),
      row("meeting", 30_000_000),
      row("signed", 40_000_000),
      row("lost", 50_000_000),
    ]);
    expect(s.pipelineVolume).toBe(50_000_000); // target + meeting
    expect(s.activeCount).toBe(2);
    expect(s.signedCount).toBe(1);
    expect(s.signedVolume).toBe(40_000_000);
    expect(s.lostCount).toBe(1);
    expect(s.conversionRate).toBeCloseTo(1 / 4);
  });

  it("handles an empty pipeline without dividing by zero", () => {
    const s = pipelineStats([]);
    expect(s.pipelineVolume).toBe(0);
    expect(s.conversionRate).toBe(0);
  });
});

describe("groupByStage", () => {
  it("buckets rows by stage with every stage present", () => {
    const groups = groupByStage([row("target"), row("target"), row("offer"), row("lost")]);
    expect(groups.target.length).toBe(2);
    expect(groups.offer.length).toBe(1);
    expect(groups.lost.length).toBe(1);
    expect(groups.meeting.length).toBe(0); // present even when empty
  });
});

describe("mergeActivity", () => {
  it("sorts newest first, drops invalid timestamps, and respects the limit", () => {
    const items = [
      { kind: "save" as const, at: "2026-07-10T00:00:00Z", text: "old" },
      { kind: "email" as const, at: "2026-07-12T00:00:00Z", text: "new" },
      { kind: "stage" as const, at: "not-a-date", text: "junk" },
      { kind: "stage" as const, at: "2026-07-11T00:00:00Z", text: "middle" },
    ];
    const merged = mergeActivity(items, 2);
    expect(merged.map(i => i.text)).toEqual(["new", "middle"]);
  });
});
