import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CurrencyInputProps {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

const fmt = (n: number) => (n ? new Intl.NumberFormat("en-US").format(Math.round(n)) : "");

export const CurrencyInput = ({ value, onChange, placeholder, className, disabled }: CurrencyInputProps) => {
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
      <Input
        type="text"
        inputMode="numeric"
        disabled={disabled}
        className="pl-6 tabular-nums"
        value={fmt(value)}
        placeholder={placeholder}
        onChange={e => {
          const raw = e.target.value.replace(/[^0-9.]/g, "");
          onChange(raw === "" ? 0 : +raw);
        }}
      />
    </div>
  );
};
