import { describe, it, expect } from "vitest";
import {
  canonical,
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../../supabase/functions/unsubscribe/token";

const SECRET = "test-secret-not-the-real-one";

describe("unsubscribe tokens", () => {
  it("round-trips the address it was minted for", async () => {
    const t = await mintUnsubscribeToken("Person@Example.com", SECRET);
    expect(await verifyUnsubscribeToken(t, SECRET)).toBe("person@example.com");
  });

  it("lowercases, so a token minted for mixed case matches the stored row", async () => {
    expect(canonical("  Foo@Bar.COM ")).toBe("foo@bar.com");
    const t = await mintUnsubscribeToken("Foo@Bar.COM", SECRET);
    expect(await verifyUnsubscribeToken(t, SECRET)).toBe("foo@bar.com");
  });

  // The whole point: the URL is the authorisation, so an attacker must not be
  // able to suppress an address they didn't get a token for.
  it("rejects a token signed with a different secret", async () => {
    const t = await mintUnsubscribeToken("a@b.com", "other-secret");
    expect(await verifyUnsubscribeToken(t, SECRET)).toBeNull();
  });

  it("rejects a swapped address that keeps a valid-looking signature", async () => {
    const good = await mintUnsubscribeToken("victim@example.com", SECRET);
    const sig = good.split(".")[1];
    const forgedEmail = btoa("attacker@example.com").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyUnsubscribeToken(`${forgedEmail}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", ".", "nodot", "a.b", "!!!.!!!", "x".repeat(500)]) {
      expect(await verifyUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  it("rejects a token whose payload isn't an email address", async () => {
    const t = await mintUnsubscribeToken("not-an-email", SECRET);
    expect(await verifyUnsubscribeToken(t, SECRET)).toBeNull();
  });

  it("is stable — the same address and secret always mint the same token", async () => {
    // Tokens deliberately never expire: an opt-out link must still work in an
    // old email, which is exactly when someone reaches for it.
    const a = await mintUnsubscribeToken("x@y.com", SECRET);
    const b = await mintUnsubscribeToken("x@y.com", SECRET);
    expect(a).toBe(b);
  });

  it("produces URL-safe tokens (no +, / or = to be mangled in a query string)", async () => {
    for (const e of ["a@b.com", "very.long.name+tag@sub.domain.example.com", "ZZ@ZZ.io"]) {
      expect(await mintUnsubscribeToken(e, SECRET)).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });
});
