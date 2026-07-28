// GoHighLevel-style application shell: fixed dark sidebar on desktop,
// slide-over drawer on mobile, content area to the right. Wraps every route.
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Calculator, LayoutDashboard, ListChecks, LogOut, Mail, Menu, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const TEAM_NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/calculator", label: "Calculator", icon: Calculator },
  { to: "/targets", label: "Targets", icon: ListChecks },
  { to: "/emails", label: "Sent Emails", icon: Mail },
  { to: "/submissions", label: "Submissions", icon: Table2 },
];

// Only ever rendered for team members now — anonymous visitors get no shell
// at all (see AppShell below), so there's no public nav variant anymore.
const SidebarContent = ({ onNavigate }: { onNavigate?: () => void }) => {
  const location = useLocation();
  const { user, authRequired, signOut } = useAuth();
  const items = TEAM_NAV;
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-6 pb-5">
        <div className="font-display font-bold text-lg leading-tight" style={{ color: "hsl(var(--success))" }}>
          Hometown Lending
        </div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-white/60 mt-0.5">LO Recruiting</div>
      </div>
      <nav className="flex-1 px-3 space-y-1" aria-label="Main">
        {items.map(item => {
          // "/" only exists as a nav target for team members; the public nav's
          // one item (Calculator) is also what renders at "/" for a signed-out
          // visitor, so treat both paths as its active state.
          const active = item.to === "/"
            ? location.pathname === "/"
            : item.to === "/calculator"
              ? location.pathname === "/" || location.pathname.startsWith("/calculator")
              : location.pathname.startsWith(item.to);
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
        <div className="px-3 pb-5 pt-3 border-t border-white/10 space-y-1">
          <p className="px-3 pb-1 text-xs text-white/60 truncate" title={user.email ?? undefined}>{user.email}</p>
          <ChangePasswordDialog />
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
  const { user, authRequired, loading } = useAuth();
  const isTeamMember = !authRequired || !!user;

  // While the session is still resolving we don't yet know which frame to
  // draw — render the brand backdrop only (same approach as Home) instead of
  // flashing a sidebar at a recruit or a bare page at a team member.
  if (authRequired && loading) return <div className="min-h-screen glass-bg" />;

  // External visitors see ONLY the pro forma: no sidebar, no drawer, no
  // "Team sign in". This is a recruit-facing marketing surface reached from
  // a public link; the internal chrome reads as clutter (or worse, as
  // something they're locked out of). Team sign-in stays reachable by
  // direct URL — /targets still gates through RequireAuth.
  if (!isTeamMember) return <>{children}</>;

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
      {/* Radix Sheet supplies the modal behavior a hand-rolled drawer lacks:
          focus trap, Escape-to-close, aria-modal, and body scroll lock. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="md:hidden w-64 p-0 border-white/10 glass-bg text-white [&>button]:text-white [&>button]:opacity-80"
        >
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <div className="absolute inset-0 backdrop-blur-xl bg-white/[0.06]" aria-hidden="true" />
          <div className="relative h-full">
            <SidebarContent onNavigate={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <main className="md:pl-60">{children}</main>
    </div>
  );
};
