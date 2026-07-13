import { cn } from "@/lib/utils";

export interface ChipOption<T extends string | number> {
  label: string;
  value: T;
}

interface ChipsProps<T extends string | number> {
  options: ChipOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  className?: string;
  "aria-label"?: string;
}

// One-tap pill row. Highlights the option matching `value`; a custom typed
// value simply leaves every chip unlit. Sized for thumbs on mobile.
export function Chips<T extends string | number>({ options, value, onChange, className, ...rest }: ChipsProps<T>) {
  return (
    <div role="group" aria-label={rest["aria-label"]} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-9 md:h-8 px-3 rounded-full border text-xs font-medium transition-colors tabular-nums select-none",
              active
                ? "gold-accent text-accent-foreground border-transparent shadow-sm"
                : "border-border bg-background text-muted-foreground hover:border-accent/60 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
