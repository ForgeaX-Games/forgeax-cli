import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Instance, SkillsIntrospection } from "@/lib/types";
import { displayStatus, statusVariant } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Sparkles, FileText, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SkillSummary {
  name: string;
  description?: string;
  hasSkillMd: boolean;
}

function SkillCard({ skill, onPreview }: { skill: SkillSummary; onPreview: (name: string) => void }) {
  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => skill.hasSkillMd && onPreview(skill.name)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono">{skill.name}</CardTitle>
          {skill.hasSkillMd && <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      </CardHeader>
      {skill.description && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
        </CardContent>
      )}
    </Card>
  );
}

function SkillsList({ skills, emptyMsg, onPreview }: { skills: SkillSummary[]; emptyMsg: string; onPreview: (name: string) => void }) {
  if (skills.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{emptyMsg}</p>;
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {skills.map(s => <SkillCard key={s.name} skill={s} onPreview={onPreview} />)}
    </div>
  );
}

export default function SkillsPage() {
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
          <Sparkles className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">{t.navSkills}</h1>
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

  // instanceId is narrowed to string below; useQuery moves into SkillsContent
  // so no `!` non-null assertion is needed at any query call site.
  return <SkillsContent instanceId={instanceId} onBack={() => setInstanceId(null)} />;
}

function SkillsContent({ instanceId, onBack }: { instanceId: string; onBack: () => void }) {
  const t = useT();
  const [previewSkill, setPreviewSkill] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const { data, isLoading } = useQuery<SkillsIntrospection>({
    queryKey: ["skills", instanceId],
    queryFn: () => api.cmdQuery(instanceId, "list_skills"),
  });

  const { data: skillContent } = useQuery<string>({
    queryKey: ["skill-content", instanceId, previewSkill],
    queryFn: () => api.cmdQuery<string>(instanceId, "get_skill_content", [previewSkill]),
    enabled: !!previewSkill,
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
        <Sparkles className="h-6 w-6" />
        <h1 className="text-2xl font-bold tracking-tight">{t.navSkills}</h1>
        <Badge variant="outline">{instanceId}</Badge>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <Tabs defaultValue="team">
          <TabsList>
            <TabsTrigger value="team">{t.skillTeam}</TabsTrigger>
            <TabsTrigger value="agents">{t.skillPerAgent}</TabsTrigger>
          </TabsList>

          <TabsContent value="team">
            <SkillsList
              skills={layers.find(l => l.id === "team")?.skills ?? []}
              emptyMsg={t.skillNoSkills}
              onPreview={setPreviewSkill}
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
                  <SkillsList
                    skills={agents[selectedAgent].skills}
                    emptyMsg={t.skillNoSkills}
                    onPreview={setPreviewSkill}
                  />
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={!!previewSkill} onClose={() => setPreviewSkill(null)}>
        <DialogHeader>
          <DialogTitle>{previewSkill}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <pre className="text-sm font-mono whitespace-pre-wrap bg-muted rounded-md p-4">
            {skillContent || t.loading}
          </pre>
        </div>
      </Dialog>
    </div>
  );
}
