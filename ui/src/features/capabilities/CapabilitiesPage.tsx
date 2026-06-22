import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Instance, CapabilitiesIntrospection, CapabilityPackageSummary } from "@/lib/types";
import { displayStatus, statusVariant } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Puzzle, Wrench, Plug, Box, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

function PackageCard({ pkg }: { pkg: CapabilityPackageSummary }) {
  const [expanded, setExpanded] = useState(false);
  const total = pkg.kinds.tools.length + pkg.kinds.slots.length + pkg.kinds.plugins.length;

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => setExpanded(!expanded)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono">{pkg.name}</CardTitle>
          <Badge variant="secondary">{total} items</Badge>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2 pt-0">
          {pkg.kinds.tools.length > 0 && (
            <div>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                <Wrench className="h-3 w-3" /> Tools
              </div>
              <div className="flex flex-wrap gap-1">
                {pkg.kinds.tools.map(t => <Badge key={t} variant="outline" className="text-xs font-mono">{t}</Badge>)}
              </div>
            </div>
          )}
          {pkg.kinds.slots.length > 0 && (
            <div>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                <Plug className="h-3 w-3" /> Slots
              </div>
              <div className="flex flex-wrap gap-1">
                {pkg.kinds.slots.map(s => <Badge key={s} variant="outline" className="text-xs font-mono">{s}</Badge>)}
              </div>
            </div>
          )}
          {pkg.kinds.plugins.length > 0 && (
            <div>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                <Box className="h-3 w-3" /> Plugins
              </div>
              <div className="flex flex-wrap gap-1">
                {pkg.kinds.plugins.map(p => <Badge key={p} variant="outline" className="text-xs font-mono">{p}</Badge>)}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function LayerPackages({ packages, emptyMsg }: { packages: CapabilityPackageSummary[]; emptyMsg: string }) {
  if (packages.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{emptyMsg}</p>;
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {packages.map(pkg => <PackageCard key={pkg.name} pkg={pkg} />)}
    </div>
  );
}

export default function CapabilitiesPage() {
  const t = useT();
  const [instanceId, setInstanceId] = useState<string | null>(null);

  const { data: instancesData, isLoading: instancesLoading } = useQuery<{ instances: Instance[] }>({
    queryKey: ["instances"],
    queryFn: () => api.get("/api/instances"),
    refetchInterval: 5000,
  });

  const instances = instancesData?.instances ?? [];

  if (!instanceId) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Puzzle className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">{t.navCapabilities}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t.pickInstance}</p>
        {instancesLoading ? (
          <LoadingState />
        ) : instances.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              {t.noInstances}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {instances.map(inst => (
              <Card
                key={inst.id}
                className="cursor-pointer transition-colors hover:border-primary/50"
                onClick={() => setInstanceId(inst.id)}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono truncate">{inst.id}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <Badge variant={statusVariant(inst.status)}>{displayStatus(inst.status)}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // instanceId narrowed to string here; queries move into CapabilitiesContent.
  return <CapabilitiesContent instanceId={instanceId} onBack={() => setInstanceId(null)} />;
}

function CapabilitiesContent({ instanceId, onBack }: { instanceId: string; onBack: () => void }) {
  const t = useT();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const { data, isLoading } = useQuery<CapabilitiesIntrospection>({
    queryKey: ["capabilities", instanceId],
    queryFn: () => api.cmdQuery(instanceId, "fetch_capabilities"),
  });

  const layers = data?.layers ?? [];
  const agents = data?.agents ?? {};
  const agentIds = Object.keys(agents);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Puzzle className="h-6 w-6" />
        <h1 className="text-2xl font-bold tracking-tight">{t.navCapabilities}</h1>
        <Badge variant="outline">{instanceId}</Badge>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <Tabs defaultValue="instance">
          <TabsList>
            <TabsTrigger value="instance">{t.capInstance}</TabsTrigger>
            <TabsTrigger value="team">{t.capTeam}</TabsTrigger>
            <TabsTrigger value="agents">{t.capPerAgent}</TabsTrigger>
          </TabsList>

          <TabsContent value="instance">
            <LayerPackages
              packages={layers.find(l => l.id === "instance")?.packages ?? []}
              emptyMsg={t.capNoPackages}
            />
          </TabsContent>

          <TabsContent value="team">
            <LayerPackages
              packages={layers.find(l => l.id === "team")?.packages ?? []}
              emptyMsg={t.capNoPackages}
            />
          </TabsContent>

          <TabsContent value="agents">
            {agentIds.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t.agentsNoAgents}</p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {agentIds.map(id => (
                    <button
                      key={id}
                      onClick={() => setSelectedAgent(selectedAgent === id ? null : id)}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        selectedAgent === id
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      {id}
                    </button>
                  ))}
                </div>

                {selectedAgent && agents[selectedAgent] && (
                  <div className="space-y-3">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">{t.capConfig}: {selectedAgent}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-40">
                          {JSON.stringify(agents[selectedAgent].config, null, 2)}
                        </pre>
                      </CardContent>
                    </Card>
                    <LayerPackages
                      packages={agents[selectedAgent].packages}
                      emptyMsg={t.capNoPackages}
                    />
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
