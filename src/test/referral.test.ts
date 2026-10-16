// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from "vitest";
import { REF_TTL_MS, getReferralToken, storeReferralToken } from "@/lib/referral";

const TOKEN = "0123456789abcdef";
const NOW = 1_800_000_000_000;

describe("referral token — survives the tab that clicked", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("is readable in the same session", () => {
    storeReferralToken(TOKEN, NOW);
    expect(getReferralToken(NOW)).toBe(TOKEN);
  });

  // The whole point: a recruit who comes back in a new tab (or whose mail app
  // opened the link in a webview first) used to arrive un-attributed.
  it("is still readable from a new tab (session storage gone) inside the TTL", () => {
    storeReferralToken(TOKEN, NOW);
    sessionStorage.clear();
    expect(getReferralToken(NOW + 7 * 86_400_000)).toBe(TOKEN);
  });

  it("expires after the TTL so a shared machine doesn't credit one LO forever", () => {
    storeReferralToken(TOKEN, NOW);
    sessionStorage.clear();
    expect(getReferralToken(NOW + REF_TTL_MS + 1)).toBeNull();
  });

  it("drops a malformed token on the floor on both stores", () => {
    storeReferralToken("not-a-token", NOW);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(getReferralToken(NOW)).toBeNull();
  });

  it("ignores a tampered mirror", () => {
    localStorage.setItem("htl_ref_token_v2", JSON.stringify({ t: "<script>", exp: NOW + 1000 }));
    expect(getReferralToken(NOW)).toBeNull();
    localStorage.setItem("htl_ref_token_v2", "{not json");
    expect(getReferralToken(NOW)).toBeNull();
  });
});
