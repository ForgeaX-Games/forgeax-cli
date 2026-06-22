import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Instance, TemplatesIntrospection, TemplateDetail, TemplateSummary } from "@/lib/types";
import { displayStatus, statusVariant } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { LayoutTemplate, FileJson, FileText, FolderTree, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

function TemplateCard({ template, layerId, onPreview }: {
  template: TemplateSummary;
  layerId: string;
  onPreview: (layer: string, name: string) => void;
}) {
  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => onPreview(layerId, template.name)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono">{template.name}</CardTitle>
          <div className="flex gap-1">
            {template.hasCapabilities && <Badge variant="secondary" className="text-xs">capabilities</Badge>}
            <Badge variant="outline" className="text-xs">{template.files.length} files</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-1">
          {template.files.slice(0, 5).map(f => (
            <Badge key={f} variant="outline" className="text-xs font-mono">
              {f.endsWith(".json") ? <FileJson className="h-2.5 w-2.5 mr-0.5" /> : <FileText className="h-2.5 w-2.5 mr-0.5" />}
              {f}
            </Badge>
          ))}
          {template.files.length > 5 && <Badge variant="outline" className="text-xs">+{template.files.length - 5}</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function TemplatesPage() {
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
          <LayoutTemplate className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
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

  // instanceId narrowed to string here; queries move into TemplatesContent.
  return <TemplatesContent instanceId={instanceId} onBack={() => setInstanceId(null)} />;
}

function TemplatesContent({ instanceId, onBack }: { instanceId: string; onBack: () => void }) {
  const t = useT();
  const [previewLayer, setPreviewLayer] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);

  const { data, isLoading } = useQuery<TemplatesIntrospection>({
    queryKey: ["templates", instanceId],
    queryFn: () => api.cmdQuery(instanceId, "fetch_templates"),
  });

  const { data: detail } = useQuery<TemplateDetail>({
    queryKey: ["template-detail", instanceId, previewLayer, previewName],
    queryFn: () => api.cmdQuery(instanceId, "fetch_template_detail", [previewLayer, previewName]),
    enabled: !!previewLayer && !!previewName,
  });

  const openPreview = (layer: string, name: string) => {
    setPreviewLayer(layer);
    setPreviewName(name);
  };

  const closePreview = () => {
    setPreviewLayer(null);
    setPreviewName(null);
  };

  const layers = data?.layers ?? [];
  const instanceTemplates = layers.find(l => l.id === "instance")?.templates ?? [];
  const teamTemplates = layers.find(l => l.id === "team")?.templates ?? [];
  const agentLayers = layers.filter(l => l.id.startsWith("agent:"));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <LayoutTemplate className="h-6 w-6" />
        <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
        <Badge variant="outline">{instanceId}</Badge>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <Tabs defaultValue="instance">
          <TabsList>
            <TabsTrigger value="instance">{t.tplInstance}</TabsTrigger>
            <TabsTrigger value="team">{t.tplTeam}</TabsTrigger>
            {agentLayers.length > 0 && <TabsTrigger value="agents">{t.tplPerAgent}</TabsTrigger>}
          </TabsList>

          <TabsContent value="instance">
            {instanceTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t.tplNoTemplates}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {instanceTemplates.map(tpl => (
                  <TemplateCard key={tpl.name} template={tpl} layerId="instance" onPreview={openPreview} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="team">
            {teamTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t.tplNoTemplates}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {teamTemplates.map(tpl => (
                  <TemplateCard key={tpl.name} template={tpl} layerId="team" onPreview={openPreview} />
                ))}
              </div>
            )}
          </TabsContent>

          {agentLayers.length > 0 && (
            <TabsContent value="agents">
              <div className="space-y-6">
                {agentLayers.map(layer => (
                  <div key={layer.id}>
                    <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                      <FolderTree className="h-3.5 w-3.5" />
                      {layer.id.replace("agent:", "")}
                    </h3>
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {layer.templates.map(tpl => (
                        <TemplateCard key={tpl.name} template={tpl} layerId={layer.id} onPreview={openPreview} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
          )}
        </Tabs>
      )}

      <Dialog open={!!previewName} onClose={closePreview}>
        <DialogHeader>
          <DialogTitle>{previewName} <Badge variant="outline" className="ml-2">{previewLayer}</Badge></DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto space-y-4">
          {detail?.agentJson && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1"><FileJson className="h-3 w-3" /> agent.json</h4>
              <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-48 font-mono">
                {JSON.stringify(detail.agentJson, null, 2)}
              </pre>
            </div>
          )}
          {detail?.soulMd && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1"><FileText className="h-3 w-3" /> SOUL.md</h4>
              <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {detail.soulMd}
              </pre>
            </div>
          )}
          {detail?.principleMd && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1"><FileText className="h-3 w-3" /> PRINCIPLE.md</h4>
              <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {detail.principleMd}
              </pre>
            </div>
          )}
          {detail?.files && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">{t.tplFiles}</h4>
              <div className="flex flex-wrap gap-1">
                {detail.files.map(f => <Badge key={f} variant="outline" className="text-xs font-mono">{f}</Badge>)}
              </div>
            </div>
          )}
          {!detail && <p className="text-sm text-muted-foreground">{t.loading}</p>}
        </div>
      </Dialog>
    </div>
  );
}
