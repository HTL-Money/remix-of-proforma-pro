// GoHighLevel-style application shell: fixed dark sidebar on desktop,
// slide-over drawer on mobile, content area to the right. Wraps every route.
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Calculator, LayoutDashboard, ListChecks, LogOut, Mail, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/calculator", label: "Calculator", icon: Calculator },
  { to: "/targets", label: "Targets", icon: ListChecks },
  { to: "/emails", label: "Sent Emails", icon: Mail },
];

const SidebarContent = ({ onNavigate }: { onNavigate?: () => void }) => {
  const location = useLocation();
  const { user, authRequired, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-6 pb-5">
        <div className="font-display font-bold text-lg leading-tight" style={{ color: "hsl(var(--success))" }}>
          Hometown Lending
        </div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-white/50 mt-0.5">LO Recruiting</div>
      </div>
      <nav className="flex-1 px-3 space-y-1" aria-label="Main">
        {NAV.map(item => {
          const active = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-white/10 text-white border-l-2 border-[hsl(var(--success))] pl-[10px]"
                  : "text-white/65 hover:bg-white/5 hover:text-white",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      {authRequired && user && (
        <div className="px-3 pb-5 pt-3 border-t border-white/10 space-y-2">
          <p className="px-3 text-xs text-white/50 truncate" title={user.email ?? undefined}>{user.email}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut()}
            className="w-full justify-start text-white/65 hover:text-white hover:bg-white/5"
          >
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      )}
    </div>
  );
};

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen glass-bg">
      {/* Desktop sidebar: frosted glass over the brand gradient */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col z-40 backdrop-blur-xl bg-white/[0.06] border-r border-white/10">
        <SidebarContent />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="md:hidden sticky top-0 z-40 flex items-center gap-3 px-4 py-3 backdrop-blur-xl bg-white/[0.06] border-b border-white/10">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="text-white hover:bg-white/10"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="font-display font-bold" style={{ color: "hsl(var(--success))" }}>Hometown Lending</span>
      </div>
      {open && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 glass-bg shadow-xl">
            <div className="absolute inset-0 backdrop-blur-xl bg-white/[0.06]" />
            <div className="relative h-full">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="absolute right-2 top-2 text-white hover:bg-white/10 z-10"
              >
                <X className="h-5 w-5" />
              </Button>
              <SidebarContent onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      )}

      <main className="md:pl-60">{children}</main>
    </div>
  );
};
