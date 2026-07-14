import { describe, it, expect } from "vitest";
import {
  PASSWORD_MIN_LENGTH, PASSWORD_RULES, passwordErrorMessage, signInErrorMessage, validatePassword,
} from "@/lib/password";

describe("validatePassword", () => {
  it("accepts a password meeting every rule", () => {
    const r = validatePassword("Recruit!ng2026");
    expect(r.valid).toBe(true);
    expect(r.unmet).toEqual([]);
  });

  it("rejects a too-short password even if it has all classes", () => {
    const r = validatePassword("Ab3!xY");
    expect(r.valid).toBe(false);
    expect(r.unmet.map(u => u.id)).toContain("length");
  });

  it("flags each missing character class", () => {
    expect(validatePassword("alllowercase!1a").unmet.map(u => u.id)).toContain("upper");
    expect(validatePassword("ALLUPPERCASE!1A").unmet.map(u => u.id)).toContain("lower");
    expect(validatePassword("NoDigitsHere!!!").unmet.map(u => u.id)).toContain("number");
    expect(validatePassword("NoSymbols12345A").unmet.map(u => u.id)).toContain("symbol");
  });

  it("requires the configured minimum length", () => {
    const justUnder = "Aa1!".padEnd(PASSWORD_MIN_LENGTH - 1, "x");
    const exactly = "Aa1!".padEnd(PASSWORD_MIN_LENGTH, "x");
    expect(validatePassword(justUnder).valid).toBe(false);
    expect(validatePassword(exactly).valid).toBe(true);
  });

  it("treats any non-alphanumeric as a symbol (superset of the server rule)", () => {
    const symbolRule = PASSWORD_RULES.find(r => r.id === "symbol")!;
    expect(symbolRule.test("has a space ")).toBe(true);
    expect(symbolRule.test("underscore_")).toBe(true);
    expect(symbolRule.test("PlainText12")).toBe(false);
  });
});

describe("passwordErrorMessage", () => {
  it("recognizes a leaked/pwned password rejection", () => {
    const msg = passwordErrorMessage(new Error("This password has been found in a data breach (pwned)."));
    expect(msg).toMatch(/data breach/i);
  });

  it("recognizes the weak-password policy rejection by code", () => {
    const err = Object.assign(new Error("Password is too weak"), { code: "weak_password" });
    expect(passwordErrorMessage(err)).toMatch(new RegExp(`${PASSWORD_MIN_LENGTH} characters`));
  });

  it("explains an expired session", () => {
    expect(passwordErrorMessage(new Error("Auth session missing (jwt expired)"))).toMatch(/session expired/i);
  });

  it("falls back to the raw message when unrecognized", () => {
    expect(passwordErrorMessage(new Error("Something odd happened"))).toBe("Something odd happened");
  });
});

describe("signInErrorMessage", () => {
  it("softens the invalid-credentials message", () => {
    expect(signInErrorMessage(new Error("Invalid login credentials"))).toBe("That email or password is incorrect.");
  });

  it("explains rate limiting", () => {
    expect(signInErrorMessage(new Error("Request rate limit reached, too many requests"))).toMatch(/wait a minute/i);
  });
});
