import { num } from "@/lib/retrText";
import { normalizeNmls } from "@/lib/retrReportStore";

export interface TargetRow {
  nmls: string;
  name: string | null;
  city: string | null;
  state: string | null;
  annualVolume: number;
  annualFiles: number;
}

export interface CsvParseResult {
  rows: TargetRow[];
  warnings: string[];
}

/** Split a single CSV line honoring double-quoted fields (with "" escapes). */
const splitLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
};

const HEADER_ALIASES: Record<keyof Omit<TargetRow, never>, string[]> = {
  nmls: ["nmls", "nmls #", "nmls#", "nmls id", "nmls number", "nmlsid"],
  name: ["name", "loan officer", "lo name", "officer", "full name"],
  city: ["city"],
  state: ["state", "st"],
  annualVolume: ["annual volume", "volume", "total volume", "funded volume", "annual funded volume"],
  annualFiles: ["files", "units", "loans", "file count", "annual files", "loan count"],
};

const matchColumn = (header: string): keyof TargetRow | null => {
  const h = header.trim().toLowerCase();
  for (const key of Object.keys(HEADER_ALIASES) as (keyof TargetRow)[]) {
    if (HEADER_ALIASES[key].includes(h)) return key;
  }
  return null;
};

export const parseTargetsCsv = (text: string): CsvParseResult => {
  const warnings: string[] = [];
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim() !== "");
  if (lines.length === 0) return { rows: [], warnings: ["The file is empty."] };

  const headers = splitLine(lines[0]);
  const colMap = headers.map(matchColumn);
  if (!colMap.includes("nmls")) {
    return { rows: [], warnings: ["Couldn't find an NMLS column. Expected a header like \"NMLS\" or \"NMLS #\"."] };
  }

  const rows: TargetRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const get = (key: keyof TargetRow): string => {
      const idx = colMap.indexOf(key);
      return idx >= 0 && idx < cells.length ? cells[idx] : "";
    };
    const nmls = normalizeNmls(get("nmls"));
    if (!nmls) {
      warnings.push(`Row ${i + 1}: skipped — no valid NMLS number.`);
      continue;
    }
    rows.push({
      nmls,
      name: get("name") || null,
      city: get("city") || null,
      state: get("state") || null,
      annualVolume: num(get("annualVolume")),
      annualFiles: Math.round(num(get("annualFiles"))),
    });
  }
  if (rows.length === 0 && warnings.length === 0) {
    warnings.push("No data rows found under the header.");
  }
  return { rows, warnings };
};
