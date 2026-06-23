import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { setAuthHandler, setToken, hasToken } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n/provider";
import { useT } from "@/lib/i18n/provider";
import Dashboard from "@/features/dashboard/Dashboard";
import InstanceList from "@/features/instances/InstanceList";
import InstanceDetail from "@/features/instances/InstanceDetail";
import MonitorPage from "@/features/monitor/MonitorPage";
import Packs from "@/features/packs/PacksPage";
import Keys from "@/features/keys/KeysPage";
import Channels from "@/features/channels/ChannelsPage";
import Skills from "@/features/skills/SkillsPage";
import Capabilities from "@/features/capabilities/CapabilitiesPage";
import Settings from "@/features/settings/SettingsPage";
import TemplatesPage from "@/features/templates/TemplatesPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export default function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/admin" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="instances" element={<InstanceList />} />
              <Route path="instances/:id" element={<InstanceDetail />} />
              <Route path="instances/:id/monitor/:agent" element={<MonitorPage />} />
              <Route path="packs" element={<Packs />} />
              <Route path="keys" element={<Keys />} />
              <Route path="channels" element={<Channels />} />
              <Route path="skills" element={<Skills />} />
              <Route path="capabilities" element={<Capabilities />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </BrowserRouter>
        <TokenDialog />
      </QueryClientProvider>
    </I18nProvider>
  );
}

function TokenDialog() {
  const t = useT();
  const [tokenDialog, setTokenDialog] = useState(!hasToken());
  const [tokenInput, setTokenInput] = useState("");

  const handleAuthRequired = useCallback(() => {
    setTokenDialog(true);
  }, []);

  useEffect(() => {
    setAuthHandler(handleAuthRequired);
  }, [handleAuthRequired]);

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    setToken(tokenInput.trim());
    setTokenDialog(false);
    setTokenInput("");
    queryClient.invalidateQueries();
  };

  return (
    <Dialog open={tokenDialog} onClose={() => { if (hasToken()) setTokenDialog(false); }}>
      <DialogHeader>
        <DialogTitle>{t.authTitle}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t.authDesc}{" "}
          {t.authHint} <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.agenteam/gateway.json</code>
        </p>
        <div>
          <Label htmlFor="auth-token">{t.authToken}</Label>
          <Input
            id="auth-token"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveToken(); }}
            placeholder="at_..."
            autoFocus
          />
        </div>
      </div>
      <DialogFooter>
        {hasToken() && (
          <Button variant="outline" onClick={() => setTokenDialog(false)}>{t.cancel}</Button>
        )}
        <Button onClick={handleSaveToken} disabled={!tokenInput.trim()}>
          {t.authConnect}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
