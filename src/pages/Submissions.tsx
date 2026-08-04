// Internal-only view of every pro forma saved or submitted, with the payroll
// economics promoted into real columns by 20260728000000_proforma_economics.sql
// and the recruit contact + HTL5 sourcing attribution added by
// 20260729000000_recruit_contact_and_sourcing_read.sql.
//
// This is the "back end" the recruit never sees: who they are (name, NMLS,
// email, production) and which LO holds their 90-day HTL5 claim. RLS does the
// real enforcement: anon has no select on `proformas`, `lo_sourcing` is
// select-only for authenticated, and `team_directory` (a trigger-synced table,
// never a view over auth.users) exposes exactly
// id+email of team members so a claim reads as a person, not a uuid.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { fmtPct, fmtUSD } from "@/lib/proforma";
import { isCloudConfigured } from "@/lib/retrReportStore";
import { requireSupabase } from "@/lib/supabaseClient";

interface SubmissionRow {
  id: string;
  name: string;
  source: string | null;
  nmls: string | null;
  recruitEmail: string | null;
  annualVolume: number | null;
  loSplit: number | null;
  employeeCount: number | null;
  payrollOverhead: number | null;
  derivedHoldbackPct: number | null;
  finalLoNet: number | null;
  at: string;
}

/** One HTL5 attribution claim, joined against the team directory. */
interface SourcingClaim {
  sourcedByEmail: string; // falls back to the uuid if the directory misses
  sourcedAt: string;
  expiresAt: string;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until expiry — 0 or negative means the claim has lapsed.
 *  Ceil, not floor: a claim with 12 hours left is still "1 day". */
const daysLeft = (expiresAt: string, nowMs: number): number =>
  Math.ceil((new Date(expiresAt).getTime() - nowMs) / DAY_MS);

const Submissions = () => {
  const configured = isCloudConfigured();
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [claims, setClaims] = useState<Record<string, SourcingClaim>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!configured) { setLoading(false); return; }
    (async () => {
      try {
        const sb = requireSupabase();
        const { data, error } = await sb
          .from("proformas")
          .select("id, name, source, nmls, recruit_email, annual_volume, lo_split, employee_count, payroll_overhead, derived_holdback_pct, final_lo_net, updated_at")
          .order("updated_at", { ascending: false })
          .limit(200);
        if (error) throw new Error(error.message);
        const mapped = (data ?? []).map((r: Record<string, unknown>) => ({
          id: String(r.id),
          name: String(r.name ?? "—"),
          source: r.source == null ? null : String(r.source),
          nmls: r.nmls == null ? null : String(r.nmls),
          recruitEmail: r.recruit_email == null ? null : String(r.recruit_email),
          annualVolume: num(r.annual_volume),
          loSplit: num(r.lo_split),
          employeeCount: num(r.employee_count),
          payrollOverhead: num(r.payroll_overhead),
          derivedHoldbackPct: num(r.derived_holdback_pct),
          finalLoNet: num(r.final_lo_net),
          at: String(r.updated_at),
        }));
        setRows(mapped);

        // Attribution is a second, narrower fetch (only the NMLS values on
        // this page) merged client-side — keeps the main query shape simple
        // and both tables' RLS independent. Best-effort: a sourcing outage
        // must never blank the submissions list itself.
        const nmlsValues = [...new Set(mapped.map(m => m.nmls).filter((n): n is string => !!n))];
        if (nmlsValues.length > 0) {
          try {
            const { data: sourcing, error: sErr } = await sb
              .from("lo_sourcing")
              .select("nmls, sourced_by, sourced_at, expires_at")
              .in("nmls", nmlsValues);
            if (sErr) throw new Error(sErr.message);
            const sourcerIds = [...new Set((sourcing ?? []).map((s: Record<string, unknown>) => String(s.sourced_by)))];
            let emailById: Record<string, string> = {};
            if (sourcerIds.length > 0) {
              const { data: dir } = await sb
                .from("team_directory")
                .select("id, email")
                .in("id", sourcerIds);
              emailById = Object.fromEntries((dir ?? []).map((d: Record<string, unknown>) => [String(d.id), String(d.email ?? "")]));
            }
            setClaims(Object.fromEntries((sourcing ?? []).map((s: Record<string, unknown>) => [
              String(s.nmls),
              {
                sourcedByEmail: emailById[String(s.sourced_by)] || String(s.sourced_by),
                sourcedAt: String(s.sourced_at),
                expiresAt: String(s.expires_at),
              },
            ])));
          } catch (e) {
            console.warn("Sourcing attribution unavailable:", e);
          }
        }
      } catch (e) {
        toast({ title: "Couldn't load submissions", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [configured]);

  // Rows saved before the economics columns existed have nulls, not zeros —
  // render a dash so a legacy row never reads as "$0 payroll".
  const usd = (v: number | null) => (v == null ? "—" : fmtUSD(v));
  const pct = (v: number | null) => (v == null ? "—" : fmtPct(v, 2));

  const now = Date.now();

  const claimCell = (nmls: string | null) => {
    const claim = nmls ? claims[nmls] : undefined;
    if (!claim) return <span className="text-white/40">unclaimed</span>;
    const left = daysLeft(claim.expiresAt, now);
    return (
      <div className="leading-tight">
        <div className="text-white/85">{claim.sourcedByEmail}</div>
        <div className="text-[11px] text-white/50">
          {new Date(claim.sourcedAt).toLocaleDateString()} ·{" "}
          {left > 0 ? (
            <span style={{ color: "hsl(var(--success))" }}>{left}d left</span>
          ) : (
            <span className="text-white/40">expired</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">Submissions</h1>
        <p className="text-sm text-white/65 mt-0.5">
          Every pro forma saved or submitted — recruit contact, derived payroll economics, and the
          HTL5 sourcing claim (90-day window). Internal only — none of this is shown to the loan officer.
        </p>
      </div>

      {!configured ? (
        <div className="glass-panel p-6 text-sm text-white/70">
          Supabase isn't configured, so submissions are unavailable.
        </div>
      ) : (
        <section className="glass-panel p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/65 border-b border-white/10">
                  <th className="py-3 px-4 font-semibold">Pro Forma</th>
                  <th className="py-3 px-2 font-semibold">NMLS</th>
                  <th className="py-3 px-2 font-semibold">Recruit Email</th>
                  <th className="py-3 px-2 font-semibold">HTL5 Sourced By</th>
                  <th className="py-3 px-2 font-semibold">Volume</th>
                  <th className="py-3 px-2 font-semibold">Split</th>
                  <th className="py-3 px-2 font-semibold">Team</th>
                  <th className="py-3 px-2 font-semibold">Payroll Overhead</th>
                  <th className="py-3 px-2 font-semibold">Derived Holdback</th>
                  <th className="py-3 px-2 font-semibold">Final LO Net</th>
                  <th className="py-3 px-4 font-semibold text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} className="py-10 text-center text-white/65"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={11} className="py-10 text-center text-white/65">No pro formas yet.</td></tr>
                ) : rows.map(r => (
                  <tr key={r.id} className="border-b border-white/[0.07] hover:bg-white/[0.05]">
                    <td className="py-3 px-4 font-medium text-white">
                      {r.name}
                      {r.source === "public" && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-white/10 text-white/70">self-serve</span>
                      )}
                      {r.source === "lo_direct_send" && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-success/20 text-white/80">direct send</span>
                      )}
                    </td>
                    <td className="px-2 text-white/65 tabular-nums">{r.nmls ?? "—"}</td>
                    <td className="px-2 text-white/85">{r.recruitEmail ?? "—"}</td>
                    <td className="px-2">{claimCell(r.nmls)}</td>
                    <td className="px-2 text-white/85 tabular-nums">{r.annualVolume == null ? "—" : fmtUSD(r.annualVolume, { compact: true })}</td>
                    <td className="px-2 text-white/85 tabular-nums">
                      {r.loSplit == null ? "—" : `${r.loSplit}/${100 - r.loSplit}`}
                    </td>
                    <td className="px-2 text-white/65 tabular-nums">{r.employeeCount ?? "—"}</td>
                    <td className="px-2 text-white/85 tabular-nums">{usd(r.payrollOverhead)}</td>
                    <td className="px-2 tabular-nums" style={{ color: "hsl(var(--accent))" }}>{pct(r.derivedHoldbackPct)}</td>
                    <td className="px-2 tabular-nums" style={{ color: "hsl(var(--success))" }}>{usd(r.finalLoNet)}</td>
                    <td className="px-4 text-right text-white/65 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

export default Submissions;
