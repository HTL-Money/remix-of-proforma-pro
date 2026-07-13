import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { parseMoney } from "@/lib/money";

interface CurrencyInputProps {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

const fmt = (n: number) => (n ? new Intl.NumberFormat("en-US").format(Math.round(n)) : "");

// Money field that accepts shorthand ("48m", "480k", "1.5mm") and commits on
// blur / Enter — never mid-keystroke, so derived values (like file count)
// only react to finished numbers. Escape cancels the edit.
export const CurrencyInput = ({ value, onChange, placeholder, className, disabled, id }: CurrencyInputProps) => {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        disabled={disabled}
        className="pl-6 tabular-nums"
        value={draft ?? fmt(value)}
        placeholder={placeholder}
        onFocus={e => {
          cancelled.current = false;
          setDraft(value ? String(Math.round(value)) : "");
          const el = e.target;
          requestAnimationFrame(() => el.select());
        }}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => {
          if (!cancelled.current) onChange(parseMoney(e.target.value));
          setDraft(null);
        }}
        onKeyDown={e => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
};
