import { describe, it, expect } from "vitest";
import { enqueueRecapVideo, pollRecapVideoStatus } from "@/lib/higgsfieldVideo";

// The test environment has no VITE_SUPABASE_URL/ANON_KEY set, so
// requireSupabase() throws — these tests confirm both functions degrade
// gracefully in that state, matching the "never blocks the send / never
// breaks the recap page" contract every other best-effort generator in this
// app follows (renderRecapChartPng, renderVaultGifBase64, buildRecapDocxBase64).

describe("enqueueRecapVideo", () => {
  it("never throws, even when Supabase isn't configured", async () => {
    await expect(enqueueRecapVideo("0123456789abcdef", "iVBORw0KGgoAAA")).resolves.toBeUndefined();
  });
});

describe("pollRecapVideoStatus", () => {
  it("resolves to status 'unknown' rather than throwing when Supabase isn't configured", async () => {
    const result = await pollRecapVideoStatus("0123456789abcdef");
    expect(result).toEqual({ status: "unknown" });
  });
});
