// Structural checks on the edge-function handlers themselves. The handlers run
// under Deno and can't be imported here, so these read the source and pin the
// properties that the 2026-10-16 audit found broken: which actions are keyed,
// in what order the gates run, and which HTTP method is allowed to write.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FN = join(__dirname, "..", "..", "supabase", "functions");
const read = (p: string) => readFileSync(join(FN, p), "utf8");

describe("weekly-review — every mail-sending action requires ADMIN_TASK_KEY", () => {
  const src = read("weekly-review/index.ts");
  // Each branch starts at `if (body.action === "x")` and runs to the next one.
  const starts = [...src.matchAll(/if \(body\.action === "(\w+)"\)/g)];
  const branches = new Map(starts.map((m, i) => [m[1], src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index : undefined)]));

  it("dispatches the documented actions", () => {
    expect([...branches.keys()].sort()).toEqual(["announce", "collect", "notify", "remind", "send", "signinReport"]);
  });

  it("gates send, signinReport, announce, remind and notify on the key", () => {
    for (const action of ["send", "signinReport", "announce", "remind", "notify"]) {
      expect(branches.get(action), action).toMatch(/if \(!adminKeyOk\(body\.key\)\) return json\(403/);
    }
  });

  it("collect is the one unkeyed action, and it redacts people without the key", () => {
    expect(branches.get("collect")).toMatch(/adminKeyOk\(body\.key\) \? metrics : redactPeople\(metrics\)/);
  });
});

describe("send-recap — the negative-gain alert fires only after every gate", () => {
  const src = read("send-recap/index.ts");
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it("runs after suppression, rate limit, split, claim, opt-in and repeat", () => {
    const alert = at("await sendNegativeGainAlert(recap, to, gainAnnual)");
    expect(alert).toBeGreaterThan(at('error: "split_not_earned"'));
    expect(alert).toBeGreaterThan(at('error: "already_claimed"'));
    expect(alert).toBeGreaterThan(at('error: "no_optin"'));
    expect(alert).toBeGreaterThan(at('error: "already_sent"'));
    expect(alert).toBeLessThan(at("const subject = `Your Pro Forma Recap"));
  });

  it("is capped per hour", () => {
    expect(src).toMatch(/recentAlerts < NEGATIVE_GAIN_ALERT_CAP/);
  });

  it("canonicalizes the NMLS once, before any gate reads it", () => {
    expect(at("recap.nmls = digits;")).toBeLessThan(at('error: "already_claimed"'));
  });

  it("keys the rate limit on the normalized address and writes it normalized", () => {
    expect(src).toMatch(/sent_to=eq\.\$\{encodeURIComponent\(normalizeEmail\(to\)\)\}/);
    expect(src).not.toMatch(/sent_to: to,/);
  });
});

describe("recruit-optin and unsubscribe — GET never writes", () => {
  it("recruit-optin: GET renders the confirmation page; only POST action=consent records", () => {
    const src = read("recruit-optin/index.ts");
    const get = src.slice(src.indexOf('if (req.method === "GET")'), src.indexOf('if (req.method === "POST")'));
    expect(get).toContain("consentPage(");
    expect(get).not.toContain("consentFlow(");
    expect(src).toMatch(/if \(body\.action === "consent"\) return await consentFlow\(/);
    // The page's form must post the consent action with the token.
    const copy = read("recruit-optin/copy.ts");
    expect(copy).toContain('<input type="hidden" name="action" value="consent" />');
    expect(copy).toMatch(/<form method="post"/);
  });

  it("neither handler builds its form action from req.url (the edge runtime rewrites it)", () => {
    // Observed live: inside the runtime req.url is http:// and the
    // /functions/v1 prefix is gone, so a form action built from it pointed at
    // a URL that does not exist from the outside.
    for (const f of ["recruit-optin/index.ts", "unsubscribe/index.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\$\{url\.origin\}\$\{url\.pathname\}/);
      expect(src, f).toMatch(/SUPABASE_URL[\s\S]{0,120}\/functions\/v1\//);
    }
  });

  it("unsubscribe: GET returns the confirmation page before suppress() can run", () => {
    const src = read("unsubscribe/index.ts");
    const getReturn = src.indexOf("return html(renderUnsubscribeConfirmHtml(");
    const firstSuppressCall = src.indexOf("await suppress(email");
    expect(getReturn).toBeGreaterThan(-1);
    expect(getReturn).toBeLessThan(firstSuppressCall);
    // First opt-out source wins: a later click must not overwrite how someone left.
    expect(src).toContain("resolution=ignore-duplicates");
    expect(src).not.toContain("merge-duplicates");
  });
});
