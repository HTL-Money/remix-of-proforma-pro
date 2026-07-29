// Recruit Links — the team's PURL desk. An LO enters a recruit's email
// (required) and name (optional); the database mints an unguessable token
// (referral_links) credited to the signed-in LO via the created_by =
// auth.uid() insert policy. Handing that link to the recruit IS the
// attribution: when they self-serve a pro forma and email themselves the
// recap, send-recap resolves the token and fires the LO's 90-day HTL5
// sourcing claim — same first-sender-wins rules as a direct send.
import { useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { isValidEmail } from "@/lib/recapEmail";
import { buildReferralUrl } from "@/lib/referral";
import { isCloudConfigured } from "@/lib/retrReportStore";
import { requireSupabase } from "@/lib/supabaseClient";

interface LinkRow {
  token: string;
  createdBy: string;
  createdByEmail: string | null;
  recruitEmail: string;
  recruitName: string | null;
  createdAt: string;
  useCount: number;
  lastUsedAt: string | null;
}

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // http/permission edge — the URL is still shown to copy by hand
  }
};

const RecruitLinks = () => {
  const configured = isCloudConfigured();
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // Token of the just-created link — highlights its row and drives the
  // "created" success state on the form.
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const purl = (token: string) => buildReferralUrl(window.location.origin, token);

  const load = async () => {
    try {
      const sb = requireSupabase();
      const { data, error } = await sb
        .from("referral_links")
        .select("token, created_by, recruit_email, recruit_name, created_at, use_count, last_used_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      const mapped: LinkRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
        token: String(r.token),
        createdBy: String(r.created_by),
        createdByEmail: null,
        recruitEmail: String(r.recruit_email),
        recruitName: r.recruit_name == null ? null : String(r.recruit_name),
        createdAt: String(r.created_at),
        useCount: Number(r.use_count) || 0,
        lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at),
      }));
      // Resolve creator uuids → emails via the narrow team directory view.
      const ids = [...new Set(mapped.map(m => m.createdBy))];
      if (ids.length > 0) {
        const { data: dir } = await sb.from("lo_sourcing_directory").select("id, email").in("id", ids);
        const byId = Object.fromEntries((dir ?? []).map((d: Record<string, unknown>) => [String(d.id), String(d.email ?? "")]));
        for (const m of mapped) m.createdByEmail = byId[m.createdBy] || null;
      }
      setRows(mapped);
    } catch (e) {
      toast({ title: "Couldn't load recruit links", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!configured) { setLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const create = async () => {
    const recruitEmail = email.trim();
    if (!isValidEmail(recruitEmail)) {
      toast({ title: "Enter the recruit's email", description: "That doesn't look like a valid email address.", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const sb = requireSupabase();
      // token + created_by come from DB defaults (gen_random_bytes / auth.uid).
      const { data, error } = await sb
        .from("referral_links")
        .insert({ recruit_email: recruitEmail, recruit_name: name.trim() || null })
        .select("token")
        .single();
      if (error) throw new Error(error.message);
      const token = String(data.token);
      setJustCreated(token);
      setEmail("");
      setName("");
      const copied = await copyToClipboard(purl(token));
      toast({
        title: copied ? "Link created & copied" : "Link created",
        description: `${recruitEmail} is in the system — ${copied ? "the link is on your clipboard." : "copy the link from the list below."}`,
      });
      await load();
    } catch (e) {
      toast({ title: "Couldn't create the link", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const copyRow = async (token: string) => {
    const ok = await copyToClipboard(purl(token));
    if (ok) {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(t => (t === token ? null : t)), 2000);
    } else {
      toast({ title: "Couldn't copy", description: "Select the link text and copy it manually.", variant: "destructive" });
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">Recruit Links</h1>
        <p className="text-sm text-white/65 mt-0.5">
          Create a personalized link for a recruit. When they run their numbers and email themselves
          the recap through your link, the 90-day HTL5 sourcing claim is yours — first link or send
          to reach them wins, same as always.
        </p>
      </div>

      {!configured ? (
        <div className="glass-panel p-6 text-sm text-white/70">
          Supabase isn't configured, so recruit links are unavailable.
        </div>
      ) : (
        <>
          <section className="glass-panel p-5">
            <form
              className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end"
              onSubmit={e => { e.preventDefault(); create(); }}
            >
              <div className="space-y-1.5">
                <Label className="text-xs text-white/80">Recruit's email</Label>
                <Input
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="recruit@example.com"
                  disabled={creating}
                  className="bg-white text-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-white/80">Recruit's name (optional)</Label>
                <Input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Jane Smith"
                  disabled={creating}
                  className="bg-white text-foreground"
                />
              </div>
              <Button type="submit" disabled={creating} className="gold-accent text-accent-foreground hover:opacity-90">
                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                Create link
              </Button>
            </form>
            {justCreated && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
                <Link2 className="h-4 w-4 shrink-0" style={{ color: "hsl(var(--success))" }} />
                <code className="text-white/90 break-all">{purl(justCreated)}</code>
                <Button size="sm" variant="outline" onClick={() => copyRow(justCreated)} className="ml-auto">
                  {copiedToken === justCreated ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                  Copy
                </Button>
              </div>
            )}
          </section>

          <section className="glass-panel p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-white/65 border-b border-white/10">
                    <th className="py-3 px-4 font-semibold">Recruit</th>
                    <th className="py-3 px-2 font-semibold">Link</th>
                    <th className="py-3 px-2 font-semibold">Created By</th>
                    <th className="py-3 px-2 font-semibold">Created</th>
                    <th className="py-3 px-2 font-semibold">Uses</th>
                    <th className="py-3 px-4 font-semibold text-right">Last Used</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="py-10 text-center text-white/65"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={6} className="py-10 text-center text-white/65">No recruit links yet — create the first one above.</td></tr>
                  ) : rows.map(r => (
                    <tr key={r.token} className={`border-b border-white/[0.07] hover:bg-white/[0.05] ${r.token === justCreated ? "bg-white/[0.06]" : ""}`}>
                      <td className="py-3 px-4">
                        <div className="font-medium text-white">{r.recruitName ?? "—"}</div>
                        <div className="text-white/65">{r.recruitEmail}</div>
                      </td>
                      <td className="px-2 whitespace-nowrap">
                        <Button size="sm" variant="outline" onClick={() => copyRow(r.token)}>
                          {copiedToken === r.token ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                          Copy link
                        </Button>
                      </td>
                      <td className="px-2 text-white/65">{r.createdByEmail ?? r.createdBy.slice(0, 8)}</td>
                      <td className="px-2 text-white/65 whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</td>
                      <td className="px-2 text-white/85 tabular-nums">{r.useCount}</td>
                      <td className="px-4 text-right text-white/65 whitespace-nowrap">
                        {r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default RecruitLinks;
