// Read-only history of every recap email sent, from the recap_emails audit
// table (written by the send-recap edge function with the service role).
import { useEffect, useState } from "react";
import { ImageIcon, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { isCloudConfigured } from "@/lib/retrReportStore";
import { requireSupabase } from "@/lib/supabaseClient";

interface SentEmail {
  id: string;
  sentTo: string;
  savedName: string | null;
  loName: string | null;
  hadChart: boolean;
  at: string;
}

const SentEmails = () => {
  const configured = isCloudConfigured();
  const [rows, setRows] = useState<SentEmail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!configured) { setLoading(false); return; }
    (async () => {
      try {
        const sb = requireSupabase();
        const { data, error } = await sb
          .from("recap_emails")
          .select("id, sent_to, payload, created_at")
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw new Error(error.message);
        setRows((data ?? []).map((r: Record<string, unknown>) => {
          const p = (r.payload ?? {}) as { savedName?: string; loName?: string; chart?: unknown };
          return {
            id: String(r.id),
            sentTo: String(r.sent_to),
            savedName: p.savedName ?? null,
            loName: p.loName || null,
            hadChart: p.chart != null,
            at: String(r.created_at),
          };
        }));
      } catch (e) {
        toast({ title: "Couldn't load sent emails", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [configured]);

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">Sent Emails</h1>
        <p className="text-sm text-white/55 mt-0.5">Every pro forma recap the team has emailed.</p>
      </div>

      {!configured ? (
        <div className="glass-panel p-6 text-sm text-white/70">
          Supabase isn't configured, so email history is unavailable.
        </div>
      ) : (
        <section className="glass-panel p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/55 border-b border-white/10">
                  <th className="py-3 px-4 font-semibold">Sent To</th>
                  <th className="py-3 px-2 font-semibold">Pro Forma</th>
                  <th className="py-3 px-2 font-semibold">Loan Officer</th>
                  <th className="py-3 px-2 font-semibold">Chart</th>
                  <th className="py-3 px-4 font-semibold text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="py-10 text-center text-white/55"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className="py-10 text-center text-white/55">No recap emails sent yet.</td></tr>
                ) : rows.map(r => (
                  <tr key={r.id} className="border-b border-white/[0.07] hover:bg-white/[0.05]">
                    <td className="py-3 px-4 font-medium text-white">{r.sentTo}</td>
                    <td className="px-2 text-white/85">{r.savedName ?? "—"}</td>
                    <td className="px-2 text-white/55">{r.loName ?? "—"}</td>
                    <td className="px-2">
                      {r.hadChart
                        ? <span className="inline-flex items-center gap-1 text-xs" style={{ color: "hsl(var(--success))" }}><ImageIcon className="h-3.5 w-3.5" /> Inline</span>
                        : <span className="text-xs text-white/55">Text</span>}
                    </td>
                    <td className="px-4 text-right text-white/55 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
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

export default SentEmails;
