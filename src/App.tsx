import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LoginGate } from "@/components/LoginGate";
import Index from "./pages/Index.tsx";
import Targets from "./pages/Targets.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const { authRequired, loading, user } = useAuth();
  if (!authRequired) return <>{children}</>;
  if (loading) return <div className="min-h-screen hero-bg" />;
  if (!user) return <LoginGate />;
  return <>{children}</>;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <RequireAuth>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/targets" element={<Targets />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </RequireAuth>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
