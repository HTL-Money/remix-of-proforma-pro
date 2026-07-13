import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ArrowLeft, Upload, FileText, Trash2, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { fmtUSD, fmtNum } from "@/lib/proforma";
import { cn } from "@/lib/utils";
import { parseTargetsCsv, CsvParseResult } from "@/lib/csv";
import { Target, listTargets, importTargets, deleteTarget, listNmlsWithReports } from "@/lib/targetStore";
import { isCloudConfigured } from "@/lib/retrReportStore";

const MIN_VOLUME_OPTIONS = [
  { label: "All volumes", value: "0" },
  { label: "$5M+", value: "5000000" },
  { label: "$10M+", value: "10000000" },
];

const Targets = () => {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [withReports, setWithReports] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<CsvParseResult | null>(null);
  const [search, setSearch] = useState("");
  const [minVolume, setMinVolume] = useState("0");

  const configured = isCloudConfigured();

  const refresh = async () => {
    if (!configured) return;
    setLoading(true);
    try {
      const [rows, reports] = await Promise.all([listTargets(), listNmlsWithReports()]);
      setTargets(rows);
      setWithReports(reports);
    } catch (e) {
      toast({ title: "Couldn't load targets", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line

  const handleFile = async (file: File) => {
    const text = await file.text();
    const result = parseTargetsCsv(text);
    setPreview(result);
    if (result.rows.length === 0) {
      toast({ title: "Nothing to import", description: result.warnings[0] ?? "No valid rows found.", variant: "destructive" });
    }
  };

  const runImport = async () => {
    if (!preview || preview.rows.length === 0) return;
    setBusy(true);
    try {
      const n = await importTargets(preview.rows);
      toast({ title: "Import complete", description: `${n} target${n === 1 ? "" : "s"} saved.` });
      setPreview(null);
      refresh();
    } catch (e) {
      toast({ title: "Import failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (nmls: string) => {
    try {
      await deleteTarget(nmls);
      setTargets(ts => ts.filter(t => t.nmls !== nmls));
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  };

  const filtered = useMemo(() => {
    const min = Number(minVolume);
    const q = search.trim().toLowerCase();
    return targets.filter(t =>
      t.annualVolume >= min &&
      (q === "" || (t.name ?? "").toLowerCase().includes(q) || t.nmls.includes(q) || (t.city ?? "").toLowerCase().includes(q))
    );
  }, [targets, minVolume, search]);

  return (
    <div className="min-h-screen bg-background">
      <header className="hero-bg text-primary-foreground border-b border-border/40">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-2xl md:text-3xl" style={{ color: "hsl(var(--success))" }}>Target Loan Officers</h1>
            <p className="text-sm text-primary-foreground/75 mt-1">Your recruiting list. Import from CSV, then open a pro forma for any LO.</p>
          </div>
          <Button asChild variant="outline" className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground">
            <Link to="/calculator"><ArrowLeft className="h-4 w-4 mr-1" /> Pro Forma</Link>
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {!configured ? (
          <div className="premium-card p-6 text-sm text-muted-foreground">
            Supabase isn't configured, so the target list is unavailable. Add credentials to <code>.env</code> to enable it.
          </div>
        ) : (
          <>
            {/* Import */}
            <section className="premium-card p-6 space-y-3">
              <Label>Import a CSV list</Label>
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
                onClick={() => inputRef.current?.click()}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-3 cursor-pointer transition-colors",
                  dragging ? "border-accent bg-accent/10" : "border-border hover:border-accent/60 hover:bg-accent/5",
                )}
              >
                <div className="flex items-center gap-2 text-sm">
                  <Upload className="h-4 w-4 text-accent" />
                  <span className="font-medium">Drop CSV</span>
                  <span className="text-muted-foreground hidden sm:inline">columns: NMLS, Name, City, State, Annual Volume, Files</span>
                </div>
                <Button type="button" variant="outline" size="sm"><FileText className="h-3.5 w-3.5" /> Browse</Button>
                <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
              </div>

              {preview && (
                <div className="space-y-2">
                  {preview.rows.length > 0 && (
                    <div className="flex items-center gap-3 text-sm">
                      <span className="inline-flex items-center gap-1 text-success">
                        <CheckCircle2 className="h-4 w-4" /> {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} ready
                      </span>
                      <Button size="sm" onClick={runImport} disabled={busy} className="gold-accent text-accent-foreground hover:opacity-90">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} Import {preview.rows.length}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
                    </div>
                  )}
                  {preview.warnings.length > 0 && (
                    <div className="space-y-0.5 max-h-32 overflow-y-auto">
                      {preview.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-amber-600">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Controls */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1 flex-1 min-w-[220px] max-w-sm">
                <Label className="text-xs">Search</Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, NMLS, or city" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Minimum volume</Label>
                <Select value={minVolume} onValueChange={setMinVolume}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MIN_VOLUME_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground pb-2 ml-auto">
                {filtered.length} of {targets.length} shown
              </p>
            </div>

            {/* Table */}
            <section className="premium-card p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-3 px-4 font-semibold">Loan Officer</th>
                      <th className="py-3 px-2 font-semibold">NMLS</th>
                      <th className="py-3 px-2 font-semibold">Location</th>
                      <th className="py-3 px-2 font-semibold">Annual Volume</th>
                      <th className="py-3 px-2 font-semibold">Files</th>
                      <th className="py-3 px-2 font-semibold">RETR</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={7} className="py-10 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
                    ) : filtered.length === 0 ? (
                      <tr><td colSpan={7} className="py-10 text-center text-muted-foreground">
                        {targets.length === 0 ? "No targets yet. Import a CSV above to get started." : "No targets match your filters."}
                      </td></tr>
                    ) : filtered.map(t => (
                      <tr key={t.nmls} className="border-b border-border/60 hover:bg-secondary/30">
                        <td className="py-3 px-4 font-medium text-primary">{t.name || "—"}</td>
                        <td className="px-2 tabular-nums">{t.nmls}</td>
                        <td className="px-2 text-muted-foreground">{[t.city, t.state].filter(Boolean).join(", ") || "—"}</td>
                        <td className="px-2 tabular-nums">{t.annualVolume ? fmtUSD(t.annualVolume, { compact: true }) : "—"}</td>
                        <td className="px-2 tabular-nums">{t.annualFiles ? fmtNum(t.annualFiles) : "—"}</td>
                        <td className="px-2">
                          {withReports.has(t.nmls)
                            ? <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> On file</span>
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 text-right whitespace-nowrap">
                          <Button size="sm" variant="outline" onClick={() => navigate(`/calculator?nmls=${t.nmls}`)}>
                            <ExternalLink className="h-3.5 w-3.5 mr-1" /> Pro Forma
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => remove(t.nmls)} className="ml-1 text-destructive hover:bg-destructive/10">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
};

export default Targets;
