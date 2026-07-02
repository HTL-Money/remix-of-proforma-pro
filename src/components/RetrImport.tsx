import { useRef, useState } from "react";
import { Upload, FileText, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseRetrPdf, RetrParseResult } from "@/lib/retrParser";
import { fmtUSD, fmtNum } from "@/lib/proforma";
import { cn } from "@/lib/utils";

interface Props {
  onImport: (r: RetrParseResult) => void;
}

export const RetrImport = ({ onImport }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<RetrParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const result = await parseRetrPdf(file);
      if (!result.annualVolume || !result.annualFiles) {
        throw new Error("Couldn't find 'Loan Volume: $X (N)' in this PDF. Is it a RETR Track Record?");
      }
      setLast(result);
      onImport(result);
    } catch (e: any) {
      setError(e?.message ?? "Failed to parse PDF.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handle(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 cursor-pointer transition-colors",
          dragging ? "border-accent bg-accent/10" : "border-border hover:border-accent/60 hover:bg-accent/5",
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Upload className="h-4 w-4 text-accent" />}
          <span className="font-medium">Drop RETR PDF</span>
          <span className="text-muted-foreground hidden sm:inline">to auto-fill production fields</span>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy}>
          <FileText className="h-3.5 w-3.5" /> Browse
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = ""; }}
        />
      </div>
      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
      {last && !error && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Imported
            {last.recruitName ? `: ${last.recruitName}` : ""}
          </span>
          <span className="tabular-nums">{fmtUSD(last.annualVolume, { compact: true })} • {fmtNum(last.annualFiles)} files</span>
          <span className="tabular-nums">Purchase {fmtNum(last.purchaseCount)} ({fmtUSD(last.purchaseVolume, { compact: true })}) • Refi {fmtNum(last.refiCount)} ({fmtUSD(last.refiVolume, { compact: true })})</span>
          <span className="tabular-nums">FHA {last.byLoanType.fha} • VA {last.byLoanType.va} • Conv {last.byLoanType.conv}</span>
        </div>
      )}
      {last && !error && last.warnings.length > 0 && (
        <div className="space-y-0.5">
          {last.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
