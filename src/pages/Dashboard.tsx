// GoHighLevel-style dashboard in glassmorphism: KPI cards, drag-and-drop
// recruiting pipeline board, stage distribution chart, and recent-activity
// feed — frosted panels over the brand gradient. Shared team view.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, DollarSign, Loader2, Mail, Trophy, Users } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/hooks/use-toast";
import { fmtUSD } from "@/lib/proforma";
import { isCloudConfigured } from "@/lib/retrReportStore";
import {
  ALL_STAGES, ActivityItem, STAGES, StageKey, TargetWithStage,
  groupByStage, listPipeline, loadActivity, pipelineStats, setStage, stageLabel,
} from "@/lib/pipeline";
import { requireSupabase } from "@/lib/supabaseClient";

const MINT = "hsl(var(--success))";

const KPI = ({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub?: string }) => (
  <div className="glass-panel p-5">
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">
      <Icon className="h-3.5 w-3.5" style={{ color: MINT }} /> {label}
    </div>
    <div className="mt-2 text-2xl md:text-3xl font-bold text-white tabular-nums">{value}</div>
    {sub && <div className="mt-1 text-xs text-white/50">{sub}</div>}
  </div>
);

const Dashboard = () => {
  const navigate = useNavigate();
  const configured = isCloudConfigured();
  const [rows, setRows] = useState<TargetWithStage[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [emailCount, setEmailCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragNmls, setDragNmls] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<StageKey | null>(null);

  const refresh = async () => {
    if (!configured) { setLoading(false); return; }
    setLoading(true);
    try {
      const sb = requireSupabase();
      const [pipeline, feed, emails] = await Promise.all([
        listPipeline(),
        loadActivity().catch(() => [] as ActivityItem[]),
        sb.from("recap_emails").select("id", { count: "exact", head: true }),
      ]);
      setRows(pipeline);
      setActivity(feed);
      setEmailCount(emails.count ?? 0);
    } catch (e) {
      toast({ title: "Couldn't load the dashboard", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line

  const stats = useMemo(() => pipelineStats(rows), [rows]);
  const groups = useMemo(() => groupByStage(rows), [rows]);
  const maxStageCount = useMemo(
    () => Math.max(1, ...STAGES.map(s => groups[s.key].length)),
    [groups],
  );

  const move = async (t: TargetWithStage, to: StageKey) => {
    if (t.stage === to) return;
    const prev = rows;
    setRows(rs => rs.map(r => (r.nmls === t.nmls ? { ...r, stage: to } : r))); // optimistic
    try {
      await setStage(t.nmls, to, t.stage);
      setActivity(a => [{ kind: "stage", at: new Date().toISOString(), text: `NMLS ${t.nmls} moved ${stageLabel(t.stage)} → ${stageLabel(to)}` }, ...a].slice(0, 15));
    } catch (e) {
      setRows(prev);
      toast({ title: "Couldn't move recruit", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };

  if (!configured) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="glass-panel p-6 text-sm text-white/70">
          Supabase isn't configured, so the dashboard is unavailable. Add credentials to <code>.env</code> to enable it.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-6 space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">Dashboard</h1>
        <p className="text-sm text-white/55 mt-0.5">Your recruiting pipeline at a glance.</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KPI icon={DollarSign} label="Pipeline Volume" value={fmtUSD(stats.pipelineVolume, { compact: true })} sub={`${stats.activeCount} recruit${stats.activeCount === 1 ? "" : "s"} in play`} />
        <KPI icon={Users} label="Recruits in Play" value={String(stats.activeCount)} sub={`${rows.length} total on the list`} />
        <KPI icon={Mail} label="Pro Formas Sent" value={emailCount == null ? "—" : String(emailCount)} sub="recap emails delivered" />
        <KPI icon={Trophy} label="Signed" value={String(stats.signedCount)} sub={`${Math.round(stats.conversionRate * 100)}% conversion · ${fmtUSD(stats.signedVolume, { compact: true })} volume`} />
      </div>

      {/* Pipeline board */}
      <section className="space-y-2">
        <h2 className="text-xs font-bold text-white/70 uppercase tracking-[0.14em]">Pipeline</h2>
        {loading ? (
          <div className="glass-panel p-10 text-center text-white/60"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
        ) : rows.length === 0 ? (
          <div className="glass-panel p-8 text-sm text-white/60 text-center">
            No recruits yet — import your target list on the Targets page and everyone appears here in the “Target” stage.
          </div>
        ) : (
          <div className="overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-max">
              {ALL_STAGES.map(stage => (
                <div
                  key={stage.key}
                  data-stage={stage.key}
                  onDragOver={e => { e.preventDefault(); setOverStage(stage.key); }}
                  onDragLeave={() => setOverStage(s => (s === stage.key ? null : s))}
                  onDrop={e => {
                    e.preventDefault();
                    setOverStage(null);
                    const nmls = e.dataTransfer.getData("text/nmls") || dragNmls;
                    const t = rows.find(r => r.nmls === nmls);
                    if (t) move(t, stage.key);
                    setDragNmls(null);
                  }}
                  className={`w-60 shrink-0 glass-subtle flex flex-col max-h-[520px] transition-colors ${
                    overStage === stage.key ? "!border-[hsl(var(--success))]" : ""
                  } ${stage.key === "lost" ? "opacity-75" : ""}`}
                >
                  <div className="px-3 py-2.5 flex items-center justify-between border-b border-white/10">
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/80">{stage.label}</span>
                    <span className="text-[11px] font-semibold rounded-full glass-chip text-white px-2 py-0.5 tabular-nums">
                      {groups[stage.key].length}
                    </span>
                  </div>
                  <div className="p-2 space-y-2 overflow-y-auto">
                    {groups[stage.key].map(t => (
                      <div
                        key={t.nmls}
                        draggable
                        onDragStart={e => { setDragNmls(t.nmls); e.dataTransfer.setData("text/nmls", t.nmls); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => setDragNmls(null)}
                        className="rounded-lg bg-white/10 backdrop-blur-md border border-white/15 p-3 shadow-sm cursor-grab active:cursor-grabbing space-y-1 hover:bg-white/[0.14] transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-white leading-tight">{t.name || `NMLS ${t.nmls}`}</p>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`Move ${t.name || t.nmls} to another stage`}
                              className="text-white/50 hover:text-white text-xs px-1 -mr-1 shrink-0"
                            >
                              ⋯
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {ALL_STAGES.filter(s => s.key !== t.stage).map(s => (
                                <DropdownMenuItem key={s.key} onClick={() => move(t, s.key)}>
                                  Move to {s.label}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuItem onClick={() => navigate(`/calculator?nmls=${t.nmls}`)}>
                                Open pro forma
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <p className="text-xs text-white/60">
                          {t.annualVolume ? fmtUSD(t.annualVolume, { compact: true }) : "—"}
                          {t.city ? ` · ${t.city}${t.state ? `, ${t.state}` : ""}` : ""}
                        </p>
                        <p className="text-[10px] text-white/40 tabular-nums">NMLS {t.nmls}</p>
                      </div>
                    ))}
                    {groups[stage.key].length === 0 && (
                      <p className="text-xs text-white/35 text-center py-4">Drop a card here</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Stage chart + activity feed */}
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="glass-panel p-5 space-y-3">
          <h2 className="text-xs font-bold text-white/70 uppercase tracking-[0.14em]">Recruits by Stage</h2>
          <div className="space-y-2" role="img" aria-label={`Recruits by stage: ${STAGES.map(s => `${s.label} ${groups[s.key].length}`).join(", ")}`}>
            {STAGES.map(s => (
              <div key={s.key} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-white/55">{s.label}</span>
                <div className="flex-1 h-4 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(groups[s.key].length === 0 ? 0 : 4, (groups[s.key].length / maxStageCount) * 100)}%`, background: MINT }}
                  />
                </div>
                <span className="w-6 text-right text-xs font-semibold text-white tabular-nums">{groups[s.key].length}</span>
              </div>
            ))}
          </div>
          {stats.lostCount > 0 && (
            <p className="text-xs text-white/45">{stats.lostCount} marked lost (not shown in funnel).</p>
          )}
        </section>

        <section className="glass-panel p-5 space-y-3">
          <h2 className="text-xs font-bold text-white/70 uppercase tracking-[0.14em] flex items-center gap-2">
            <Activity className="h-4 w-4" style={{ color: MINT }} /> Recent Activity
          </h2>
          {activity.length === 0 ? (
            <p className="text-sm text-white/55 py-4">Activity shows up here as your team saves pro formas, sends recaps, and moves recruits.</p>
          ) : (
            <ul className="space-y-2.5">
              {activity.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: MINT }} />
                  <span className="min-w-0">
                    <span className="text-white/85">{a.text}</span>
                    <span className="block text-[11px] text-white/40">{new Date(a.at).toLocaleString()}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default Dashboard;
