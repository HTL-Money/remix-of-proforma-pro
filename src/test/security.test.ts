// Automated enforcement for security/README.md — these tests ARE the posture.
// If one fails, either something leaked/regressed (fix it) or the posture
// changed deliberately (update security/*.md and the invariant here in the
// same PR).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";
import type { Employee, ModelState } from "@/lib/proforma";

const ROOT = join(__dirname, "..", "..");

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

// ---------------------------------------------------------------------------
// 1. Secret scan — no credential shapes in any tracked file
// ---------------------------------------------------------------------------

// Two base64url segments joined by a dot = a real JWT, not just a string that
// starts with eyJ. Long enough to skip false positives on tiny fixtures.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { name: "Resend API key", re: /\bre_[A-Za-z0-9]{16,}\b/ },
  { name: "generic sk- secret", re: /\bsk[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

// Binary/media formats can't carry usable secrets for our threat model and
// trip regexes on random bytes.
const SCAN_SKIP = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|lock)$|^package-lock\.json$|^bun\.lockb$/;

describe("secret scan — tracked files", () => {
  it("contains no JWTs, API keys, or private key blocks", () => {
    const offenders: string[] = [];
    for (const f of trackedFiles()) {
      if (SCAN_SKIP.test(f)) continue;
      const p = join(ROOT, f);
      if (!existsSync(p) || statSync(p).isDirectory()) continue;
      const text = readFileSync(p, "utf8");
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) offenders.push(`${f}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. .env hygiene
// ---------------------------------------------------------------------------

describe(".env hygiene", () => {
  it(".gitignore covers .env", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gitignore.split("\n")).toContain(".env");
  });

  it("no .env file is tracked by git (only the placeholder template)", () => {
    const envTracked = trackedFiles().filter(f => /(^|\/)\.env(\..+)?$/.test(f));
    // .env.example is the one legitimate tracked env file — and only as a
    // placeholder template. The JWT/secret patterns above already scan it;
    // this asserts it doesn't hold a real-looking Supabase URL either.
    expect(envTracked.filter(f => !f.endsWith(".env.example"))).toEqual([]);
    if (envTracked.includes(".env.example")) {
      const tmpl = readFileSync(join(ROOT, ".env.example"), "utf8");
      expect(tmpl).toContain("your-project");
      expect(tmpl).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. RLS invariants — replay every migration's policy statements
// ---------------------------------------------------------------------------

interface LivePolicy {
  name: string;
  table: string;
  cmd: string;
  roles: string[];
  body: string;
}

/** Replays create/drop policy statements across migrations in filename order,
 *  returning the net (live) policy set — the same thing Postgres would hold. */
const livePolicies = (): LivePolicy[] => {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  const live = new Map<string, LivePolicy>();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    // strip line comments so commented-out examples don't count
    const clean = sql.replace(/--[^\n]*/g, "");
    for (const stmt of clean.split(";")) {
      const create = /create\s+policy\s+"([^"]+)"\s+on\s+([\w.]+)([\s\S]*)/i.exec(stmt);
      if (create) {
        const [, name, table, rest] = create;
        const cmd = /for\s+(select|insert|update|delete|all)/i.exec(rest)?.[1].toLowerCase() ?? "all";
        const roles = (/\bto\s+([\w,\s]+?)(?:\s+using|\s+with|$)/i.exec(rest)?.[1] ?? "public")
          .split(",")
          .map(r => r.trim().toLowerCase())
          .filter(Boolean);
        live.set(`${table}:${name}`, { name, table, cmd, roles, body: rest });
        continue;
      }
      const drop = /drop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+([\w.]+)/i.exec(stmt);
      if (drop) live.delete(`${drop[2]}:${drop[1]}`);
    }
  }
  return [...live.values()];
};

describe("RLS invariants (net state across all migrations)", () => {
  const policies = livePolicies();
  const anonPolicies = policies.filter(p => p.roles.includes("anon"));

  it("exactly one live policy grants anon anything", () => {
    expect(anonPolicies.map(p => `${p.table} ${p.cmd} (${p.name})`)).toEqual([
      "public.proformas insert (anon_insert_public_submissions)",
    ]);
  });

  it("the anon policy is insert-only and forces source='public'", () => {
    const p = anonPolicies[0];
    expect(p.cmd).toBe("insert");
    expect(p.body).toMatch(/source\s*=\s*'public'/);
  });

  it("no live policy grants the public role", () => {
    expect(policies.filter(p => p.roles.includes("public"))).toEqual([]);
  });

  it("every other live policy is authenticated-only", () => {
    const others = policies.filter(p => !p.roles.includes("anon"));
    for (const p of others) expect(p.roles).toEqual(["authenticated"]);
  });

  it("no raw GRANT statements to anon exist in any migration", () => {
    const dir = join(ROOT, "supabase", "migrations");
    for (const f of readdirSync(dir).filter(f => f.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      expect(sql).not.toMatch(/\bgrant\b[\s\S]{0,120}?\bto\s+anon\b/i);
    }
  });

  it("retr_stats_cache has RLS enabled and ZERO client policies", () => {
    // The cache is service-role-only by design: any policy appearing on it
    // would widen the anon-visible surface of RETR production data.
    expect(policies.filter(p => p.table.includes("retr_stats_cache"))).toEqual([]);
    const dir = join(ROOT, "supabase", "migrations");
    const sql = readdirSync(dir)
      .filter(f => f.endsWith(".sql"))
      .map(f => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(sql).toMatch(/retr_stats_cache\s+enable\s+row\s+level\s+security/i);
  });

  it("the retr-reports bucket ends up private", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
    let publicState: boolean | null = null;
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      if (/insert into storage\.buckets[\s\S]*?'retr-reports'[\s\S]*?true/i.test(sql)) publicState = true;
      if (/update storage\.buckets\s+set\s+public\s*=\s*false[\s\S]*?'retr-reports'/i.test(sql)) publicState = false;
    }
    expect(publicState).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Payload isolation — employee data never leaves the app
// ---------------------------------------------------------------------------

describe("payload isolation — the outbound boundary", () => {
  const stateWithEmployees = (): ModelState => ({
    ...defaultState(),
    recruitName: "Jane Smith",
    nmls: "123456",
    annualVolume: 30_000_000,
    annualFiles: 100,
    avgLoanAmount: 300_000,
    currentSplit: 2.0,
    employees: [
      {
        id: "e1",
        name: "SECRET-EMPLOYEE-ALICE",
        role: "Processor",
        salary: 87_654,
        salarySource: "HTL",
        qmBonus: 150,
        nonQmBonus: 250,
        bonusSource: "HTL",
        extraBonus: 0,
      },
      {
        id: "e2",
        name: "SECRET-EMPLOYEE-BOB",
        role: "LOA",
        salary: 65_432,
        salarySource: "Broker",
        qmBonus: 0,
        nonQmBonus: 0,
        bonusSource: "Broker",
        extraBonus: 150,
      },
    ] satisfies Employee[],
  });

  it("RecapPayload contains no employee names, salaries, or employee objects", () => {
    const s = stateWithEmployees();
    const json = JSON.stringify(buildRecapPayload("save", s, calculate(s)));
    expect(json).not.toContain("SECRET-EMPLOYEE");
    expect(json).not.toContain("87654");
    expect(json).not.toContain("65432");
    expect(json).not.toContain('"employees"');
    expect(json).not.toContain('"salary"');
  });

  it("the Word report inherits the boundary (consumes RecapPayload only)", () => {
    // recapDocx.ts imports RecapPayload, never ModelState — verified
    // structurally so a refactor can't quietly widen its inputs.
    const src = readFileSync(join(ROOT, "src", "lib", "recapDocx.ts"), "utf8");
    expect(src).not.toMatch(/ModelState/);
    expect(src).toMatch(/RecapPayload/);
  });

  it("the vault animation inherits the boundary (numbers + labels only)", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "vaultGif.ts"), "utf8");
    expect(src).not.toMatch(/ModelState/);
  });
});

// ---------------------------------------------------------------------------
// 5. Bundle hygiene — the shipped JS carries the anon key and nothing else
// ---------------------------------------------------------------------------

describe("bundle hygiene (runs only when dist/ exists)", () => {
  const dist = join(ROOT, "dist");
  const it_ = existsSync(dist) ? it : it.skip;

  it_("dist/ contains no JWT other than the public anon key", () => {
    // The anon key is expected in the bundle (public by design). Any OTHER
    // JWT-shaped string is a leak. Read the allowed key from .env when
    // present; otherwise allow only role:"anon" JWTs (decoded check).
    let anonKey: string | null = null;
    const envPath = join(ROOT, ".env");
    if (existsSync(envPath)) {
      anonKey = /VITE_SUPABASE_ANON_KEY=([^\s]+)/.exec(readFileSync(envPath, "utf8"))?.[1] ?? null;
    }
    const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(js|css|html|json|webmanifest)$/.test(entry)) continue;
        const text = readFileSync(p, "utf8");
        for (const m of text.match(jwtRe) ?? []) {
          if (anonKey && m === anonKey) continue;
          try {
            const payload = JSON.parse(Buffer.from(m.split(".")[1], "base64url").toString());
            if (payload.role === "anon") continue; // the public key by role
          } catch {
            /* undecodable = treat as a leak */
          }
          offenders.push(`${p}: ${m.slice(0, 24)}…`);
        }
      }
    };
    walk(dist);
    expect(offenders).toEqual([]);
  });
});
