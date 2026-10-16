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

  // The role split made retr_reports (the table) admin-only on writes; the
  // bucket that holds the PDFs has to match, or any signed-in LO can plant a
  // "verified" report for an NMLS that the shared store then serves to the team.
  it("storage writes to the retr-reports bucket require is_admin()", () => {
    const writes = policies.filter(
      p => p.table === "storage.objects" && ["insert", "update", "delete", "all"].includes(p.cmd),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const p of writes) {
      expect(p.body, `${p.name} (${p.cmd})`).toMatch(/is_admin\(\)/);
    }
  });

  // CLAUDE.md calls is_admin() the CRM boundary. The role check above only
  // proves a policy targets `authenticated`; this proves the body actually
  // gates on admin membership (or on the row's owner where the table is
  // own-or-admin), so a migration reopening target_los with `using (true)`
  // can't pass the suite.
  it("the CRM tables are gated on is_admin() in the policy body", () => {
    const adminOnly: Array<[string, string[]]> = [
      ["public.target_los", ["select", "insert", "update", "delete", "all"]],
      ["public.stage_events", ["select", "insert", "update", "delete", "all"]],
      ["public.proformas", ["update", "delete"]],
      ["public.recap_emails", ["delete"]],
      ["public.retr_reports", ["insert", "update", "delete"]],
      ["public.proforma_snapshots", ["select"]],
      ["public.metrics_snapshots", ["select"]],
    ];
    for (const [table, cmds] of adminOnly) {
      const ps = policies.filter(p => p.table === table && cmds.includes(p.cmd) && !p.roles.includes("anon"));
      expect(ps.length, `${table} has a policy for ${cmds.join("/")}`).toBeGreaterThan(0);
      for (const p of ps) expect(p.body, `${table} ${p.cmd} (${p.name})`).toMatch(/is_admin\(\)/);
    }
    const ownOrAdmin: Array<[string, string[]]> = [
      ["public.proformas", ["select"]],
      ["public.recap_emails", ["select"]],
      ["public.referral_links", ["select"]],
      ["public.recruit_optins", ["select"]],
    ];
    for (const [table, cmds] of ownOrAdmin) {
      const ps = policies.filter(p => p.table === table && cmds.includes(p.cmd) && !p.roles.includes("anon"));
      expect(ps.length, `${table} has a policy for ${cmds.join("/")}`).toBeGreaterThan(0);
      for (const p of ps) expect(p.body, `${table} ${p.cmd} (${p.name})`).toMatch(/auth\.uid\(\)/);
    }
  });

  // SECURITY DEFINER functions run as their owner, so PostgREST exposing
  // them under /rest/v1/rpc/ to anon is a privilege escalation waiting for
  // a body. Supabase grants EXECUTE to anon by default on every function in
  // public; every definer function therefore needs an explicit revoke.
  it("every SECURITY DEFINER function is revoked from anon in the migrations", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const sql = readdirSync(dir)
      .filter(f => f.endsWith(".sql"))
      .sort()
      .map(f => readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, ""))
      .join("\n");
    // Segment the SQL at each function definition so "security definer" is
    // attributed to the function whose body contains it, not an earlier one.
    const starts = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)];
    const definers = new Set<string>();
    starts.forEach((m, i) => {
      const segment = sql.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index : undefined);
      if (/security\s+definer/i.test(segment)) definers.add(m[1].toLowerCase());
    });
    expect(definers.size).toBeGreaterThan(0);
    for (const fn of definers) {
      const revoked = new RegExp(`revoke\\s+execute\\s+on\\s+function[^;]*\\b${fn}\\s*\\([^;]*\\bfrom\\b[^;]*\\banon\\b`, "i");
      expect(sql, `revoke execute on function ${fn}() ... from anon`).toMatch(revoked);
    }
  });

  // The ledger on the live project is keyed on the 14-digit filename prefix;
  // a stray name here would be a migration the ledger can never record.
  it("migration filenames are ledger-shaped and unique by version", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter(f => f.endsWith(".sql"));
    const versions = new Set<string>();
    for (const f of files) {
      expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      const v = f.slice(0, 14);
      expect(versions.has(v), `duplicate version ${v}`).toBe(false);
      versions.add(v);
    }
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
        // Broker-paid so the payload's payroll figure is a genuine AGGREGATE
        // (Alice + Bob). With a single broker-paid employee the honest total
        // necessarily equals that one salary — the boundary this test guards
        // is per-employee objects/names/fields, not the arithmetic sum.
        salarySource: "Broker",
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
  // Locally a missing dist/ just skips (run `npm run test:ci` to include it).
  // Under CI a missing dist/ is a pipeline bug — the build step must run
  // first — so the test fails rather than quietly passing the suite.
  const hasDist = existsSync(dist);
  if (!hasDist && !process.env.CI) {
    console.warn("bundle hygiene skipped: no dist/ — run `npm run test:ci` to build first");
  }
  const it_ = hasDist || process.env.CI ? it : it.skip;

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
