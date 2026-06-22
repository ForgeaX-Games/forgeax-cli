import { useParams, Link, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import type { InstanceDetail, TeamInfo, PackMeta } from "@/lib/types";
import { displayStatus, statusVariant } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import type { Messages } from "@/lib/i18n";
import { ArrowLeft, Play, Square, RotateCcw, Ban, Trash2, Package, Save, ArchiveRestore, FileJson, Container, Activity, Puzzle, Sparkles, LayoutTemplate } from "lucide-react";

export default function InstanceDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: inst, isLoading } = useQuery<InstanceDetail>({
    queryKey: ["instances", id],
    queryFn: () => api.get(`/api/instances/${id}`),
    refetchInterval: 3000,
  });

  const actionMutation = useMutation({
    mutationFn: (action: string) => api.post(`/api/instances/${id}/${action}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["instances"] }); setActionError(null); },
    onError: (e: any) => setActionError(e?.message ?? String(e)),
  });

  const freeMutation = useMutation({
    mutationFn: () => api.post(`/api/instances/${id}/free`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["instances"] }); window.location.href = "/admin/instances"; },
    onError: (e: any) => setActionError(e?.message ?? String(e)),
  });

  if (isLoading) return <LoadingState />;
  if (!inst) return <div className="text-destructive">{t.instNotFound}</div>;

  const ds = displayStatus(inst.status);
  const canStart = ds === "stopped" || ds === "error";
  const canStop = ds === "running" || ds === "no team" || inst.status === "starting";
  const canRestart = ds === "running";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/admin/instances">
          <Button variant="ghost" size="icon" aria-label={t.instTitle}><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{inst.id}</h1>
        <Badge variant={statusVariant(inst.status)}>{ds}</Badge>

        <div className="ml-auto flex gap-2">
          {canStart && (
            <Button size="sm" onClick={() => actionMutation.mutate("start")} disabled={actionMutation.isPending}>
              <Play className="h-3 w-3" /> {t.instStart}
            </Button>
          )}
          {canStop && (
            <Button size="sm" variant="outline" onClick={() => actionMutation.mutate("stop")} disabled={actionMutation.isPending}>
              <Square className="h-3 w-3" /> {t.instStop}
            </Button>
          )}
          {canRestart && (
            <Button size="sm" variant="outline" onClick={() => actionMutation.mutate("restart")} disabled={actionMutation.isPending}>
              <RotateCcw className="h-3 w-3" /> {t.instRestart}
            </Button>
          )}
          {canRestart && (
            <Button size="sm" variant="ghost" onClick={() => actionMutation.mutate("interrupt")} disabled={actionMutation.isPending}>
              <Ban className="h-3 w-3" /> {t.instInterrupt}
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {actionError}
          <button className="ml-2 underline" onClick={() => setActionError(null)}>{t.dismiss}</button>
        </div>
      )}

      {ds === "no team" && (
        <div className="rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm text-warning-foreground">
          {t.instNoTeamBanner}
        </div>
      )}

      {inst.status === "starting" && (
        <div className="rounded-md bg-blue-500/10 border border-blue-500/30 px-4 py-3 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
          <RotateCcw className="h-4 w-4 animate-spin" />
          {t.instStartingBanner}
        </div>
      )}

      {inst.statusMessage && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {inst.statusMessage}
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t.instOverview}</TabsTrigger>
          <TabsTrigger value="team">{t.instTeam}</TabsTrigger>
          <TabsTrigger value="agents">{t.instAgents}</TabsTrigger>
          <TabsTrigger value="sessions">{t.instSessions}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab inst={inst} t={t} />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab instanceId={inst.id} qc={qc} t={t} />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab instanceId={inst.id} t={t} />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsTab instanceId={inst.id} t={t} />
        </TabsContent>
      </Tabs>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t.dangerZone}</CardTitle>
          <CardDescription>{t.dangerDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t.instDelete}</p>
              <p className="text-xs text-muted-foreground">{t.dangerDeleteDesc}</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={freeMutation.isPending}
            >
              <Trash2 className="h-3 w-3" /> {freeMutation.isPending ? t.instDeleting : t.instDelete}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); freeMutation.mutate(); }}
        title={t.instDeleteTitle}
        confirmText={t.instDelete}
        isPending={freeMutation.isPending}
      >
        <p>{t.delete} <strong>"{inst.id}"</strong> {t.instDeleteConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}

function OverviewTab({ inst, t }: { inst: InstanceDetail; t: Messages }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t.instInfo}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">ID</span><span className="font-mono">{inst.id}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t.dashStatus}</span><Badge variant={statusVariant(inst.status)}>{displayStatus(inst.status)}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t.instAutoStart}</span><span>{inst.autoStart ? t.yes : t.no}</span></div>
          {inst.createdAt && <div className="flex justify-between"><span className="text-muted-foreground">{t.instCreated}</span><span>{new Date(inst.createdAt).toLocaleString()}</span></div>}
          {inst.instanceDir && <div className="flex justify-between"><span className="text-muted-foreground">{t.instDirectory}</span><span className="font-mono text-xs truncate max-w-64">{inst.instanceDir}</span></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t.instPortMappings}</CardTitle></CardHeader>
        <CardContent>
          {inst.portMappings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.instNoPortMappings}</p>
          ) : (
            <div className="space-y-1">
              {inst.portMappings.map((p) => (
                <div key={p.hostPort} className="flex justify-between text-sm font-mono">
                  <span>host:{p.hostPort}</span>
                  <span className="text-muted-foreground">→</span>
                  <span>container:{p.containerPort}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TeamTab({ instanceId, qc, t }: { instanceId: string; qc: ReturnType<typeof useQueryClient>; t: Messages }) {
  const [loadOpen, setLoadOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [containerConfirm, setContainerConfirm] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [packId, setPackId] = useState("");
  const [backupName, setBackupName] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamSuccess, setTeamSuccess] = useState<string | null>(null);

  const { data: teamData, isLoading: teamLoading } = useQuery<TeamInfo>({
    queryKey: ["instances", instanceId, "team"],
    queryFn: () => api.get(`/api/instances/${instanceId}/team`),
    refetchInterval: 5000,
  });

  const { data: packsData } = useQuery<{ packs: PackMeta[] }>({
    queryKey: ["packs"],
    queryFn: () => api.get("/api/packs"),
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["instances"] });
    qc.invalidateQueries({ queryKey: ["instances", instanceId, "team"] });
  }

  function flash(msg: string) { setTeamSuccess(msg); setTeamError(null); setTimeout(() => setTeamSuccess(null), 4000); }

  const loadMutation = useMutation({
    mutationFn: (p: string) => api.post(`/api/instances/${instanceId}/team/load`, { packIdOrPath: p }),
    onSuccess: () => { invalidateAll(); setLoadOpen(false); setPackId(""); flash(t.teamFlashLoaded); },
    onError: (e: any) => setTeamError(e?.message ?? String(e)),
  });

  const saveMutation = useMutation({
    mutationFn: (name: string) => api.post(`/api/instances/${instanceId}/team/save`, { name }),
    onSuccess: () => { invalidateAll(); setSaveOpen(false); setBackupName(""); flash(t.teamFlashSaved); },
    onError: (e: any) => setTeamError(e?.message ?? String(e)),
  });

  const restoreMutation = useMutation({
    mutationFn: (bk: string) => api.post(`/api/instances/${instanceId}/team/restore`, { backupName: bk }),
    onSuccess: () => { invalidateAll(); flash(t.teamFlashRestored); },
    onError: (e: any) => setTeamError(e?.message ?? String(e)),
  });

  const manifestMutation = useMutation({
    mutationFn: (text: string) => api.put(`/api/instances/${instanceId}/team/manifest`, JSON.parse(text)),
    onSuccess: () => { invalidateAll(); setManifestOpen(false); flash(t.teamFlashManifest); },
    onError: (e: any) => setTeamError(e?.message ?? String(e)),
  });

  const containerMutation = useMutation({
    mutationFn: () => api.del<{ removed: string[] }>(`/api/instances/${instanceId}/team/containers`),
    onSuccess: (d) => { invalidateAll(); flash(`Removed ${(d as any)?.removed?.length ?? 0} container(s)`); },
    onError: (e: any) => setTeamError(e?.message ?? String(e)),
  });

  function openManifestEditor() {
    api.get<Record<string, unknown>>(`/api/instances/${instanceId}/team/manifest`)
      .then((m) => { setManifestText(JSON.stringify(m, null, 2)); setManifestOpen(true); })
      .catch((e) => setTeamError(e?.message ?? String(e)));
  }

  const team = teamData?.team;
  const backups = teamData?.backups ?? [];
  const packs = packsData?.packs ?? [];

  return (
    <div className="space-y-4">
      {teamError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {teamError}
          <button className="ml-2 underline cursor-pointer" onClick={() => setTeamError(null)}>{t.dismiss}</button>
        </div>
      )}
      {teamSuccess && (
        <div className="rounded-md bg-success/10 border border-success/30 px-4 py-3 text-sm text-success">
          {teamSuccess}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t.teamCurrent}</CardTitle>
              <CardDescription>
                {teamLoading ? t.loading : team ? `${team.source.id} v${team.source.version}` : t.teamNoTeam}
              </CardDescription>
            </div>
            {team && <Badge variant="success">{t.teamActive}</Badge>}
            {!team && !teamLoading && <Badge variant="secondary">{t.teamEmpty}</Badge>}
          </div>
        </CardHeader>
        {team && (
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">{t.teamId}</span><span className="font-mono">{team.teamId}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t.teamSource}</span><span>{team.source.type}: {team.source.id} v{team.source.version}</span></div>
            {team.defaultAgent && <div className="flex justify-between"><span className="text-muted-foreground">{t.teamDefaultAgent}</span><span>{team.defaultAgent}</span></div>}
            <div className="flex justify-between"><span className="text-muted-foreground">{t.instCreated}</span><span>{new Date(team.createdAt).toLocaleString()}</span></div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.teamActions}</CardTitle>
          <CardDescription>{t.teamActionsDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <button className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer" onClick={() => setLoadOpen(true)}>
              <Package className="mt-0.5 h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">{t.teamLoadPack}</p>
                <p className="text-xs text-muted-foreground">{t.teamLoadPackDesc}</p>
              </div>
            </button>
            <button className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => { setBackupName(team?.teamId ?? "backup"); setSaveOpen(true); }} disabled={!team}>
              <Save className="mt-0.5 h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">{t.teamSaveBackup}</p>
                <p className="text-xs text-muted-foreground">{t.teamSaveBackupDesc}</p>
              </div>
            </button>
            <button className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" onClick={openManifestEditor} disabled={!team}>
              <FileJson className="mt-0.5 h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">{t.teamEditManifest}</p>
                <p className="text-xs text-muted-foreground">{t.teamEditManifestDesc}</p>
              </div>
            </button>
            <button className="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer" onClick={() => setContainerConfirm(true)}>
              <Container className="mt-0.5 h-5 w-5 text-destructive shrink-0" />
              <div>
                <p className="text-sm font-medium">{t.teamRemoveContainers}</p>
                <p className="text-xs text-muted-foreground">{t.teamRemoveContainersDesc}</p>
              </div>
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.teamBackups} ({backups.length})</CardTitle>
          <CardDescription>{t.teamBackupsDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.teamNoBackups}</p>
          ) : (
            <div className="space-y-2">
              {backups.map((b) => (
                <div key={b} className="flex items-center justify-between rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <ArchiveRestore className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-sm">{b}</span>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setRestoreTarget(b)} disabled={restoreMutation.isPending}>
                    {restoreMutation.isPending ? t.teamRestoring : t.teamRestore}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={loadOpen} onClose={() => setLoadOpen(false)}>
        <DialogHeader>
          <DialogTitle>{t.teamLoadPackTitle}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t.teamLoadPackHint}</p>
        </DialogHeader>
        <div className="space-y-4">
          {packs.length > 0 ? (
            <div className="grid gap-2 max-h-[240px] overflow-y-auto pr-1">
              {packs.map((p) => (
                <button key={p.id} type="button" onClick={() => setPackId(p.id)} className={`text-left rounded-lg border p-3 transition-colors ${packId === p.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:border-primary/40"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{p.name || p.id}</span>
                    {p.version && <span className="text-xs text-muted-foreground">v{p.version}</span>}
                  </div>
                  {p.description && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{p.description}</p>}
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t.teamLoadPackEmpty}</div>
          )}
          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">{t.teamLoadFromPath}</summary>
            <div className="mt-2">
              <Input value={packs.some((p) => p.id === packId) ? "" : packId} onChange={(e) => setPackId(e.target.value)} placeholder="/absolute/path/to/pack" />
            </div>
          </details>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setLoadOpen(false); setPackId(""); }}>{t.cancel}</Button>
          <Button onClick={() => loadMutation.mutate(packId)} disabled={!packId || loadMutation.isPending}>
            {loadMutation.isPending ? t.teamLoading : t.teamLoadAction}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)}>
        <DialogHeader><DialogTitle>{t.teamSaveBackupTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>{t.teamBackupName}</Label>
          <Input value={backupName} onChange={(e) => setBackupName(e.target.value)} placeholder="my-backup" />
          <p className="text-xs text-muted-foreground">{t.teamBackupHint}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSaveOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => saveMutation.mutate(backupName)} disabled={!backupName || saveMutation.isPending}>
            {saveMutation.isPending ? t.teamSaving : t.teamSaveBackup}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={manifestOpen} onClose={() => setManifestOpen(false)}>
        <DialogHeader><DialogTitle>{t.teamEditManifestTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>manifest.json</Label>
          <Textarea className="font-mono text-xs min-h-[300px]" value={manifestText} onChange={(e) => setManifestText(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.teamManifestHint}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setManifestOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => manifestMutation.mutate(manifestText)} disabled={manifestMutation.isPending}>
            {manifestMutation.isPending ? t.saving : t.teamSaveManifest}
          </Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog open={containerConfirm} onClose={() => setContainerConfirm(false)} onConfirm={() => { setContainerConfirm(false); containerMutation.mutate(); }} title={t.teamRemoveContainersTitle} confirmText={t.teamRemoveAll} isPending={containerMutation.isPending}>
        <p>{t.teamRemoveContainersConfirm}</p>
      </ConfirmDialog>

      <ConfirmDialog open={!!restoreTarget} onClose={() => setRestoreTarget(null)} onConfirm={() => { if (restoreTarget) restoreMutation.mutate(restoreTarget); setRestoreTarget(null); }} title={t.teamRestoreTitle} confirmText={t.teamRestore} confirmVariant="default" isPending={restoreMutation.isPending}>
        <p>{t.teamRestore} <strong>"{restoreTarget}"</strong>? {t.teamRestoreConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}

function AgentsTab({ instanceId, t }: { instanceId: string; t: Messages }) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery<{ agents: string[] }>({
    queryKey: ["instances", instanceId, "agents"],
    queryFn: async () => {
      const nodes = await api.cmdQuery<Array<{ id: string }>>(instanceId, "list_agents");
      return { agents: nodes.map((n) => n.id) };
    },
    refetchInterval: 5000,
  });

  const { data: treeData } = useQuery<{ nodes: Array<{ id: string; role?: string; parentId?: string | null; children?: string[] }> }>({
    queryKey: ["instances", instanceId, "tree"],
    queryFn: async () => {
      const nodes = await api.cmdQuery<Array<{ id: string; role?: string; parentId?: string | null; children?: string[] }>>(instanceId, "fetch_agent_tree");
      return { nodes };
    },
    refetchInterval: 5000,
  });

  const { data: boardData } = useQuery<{ board: Record<string, Record<string, unknown>> }>({
    queryKey: ["instances", instanceId, "teamboard"],
    queryFn: async () => {
      const board = await api.cmdQuery<Record<string, Record<string, unknown>>>(instanceId, "fetch_teamboard");
      return { board };
    },
    refetchInterval: 5000,
  });

  if (isLoading) return <LoadingState />;
  const agents = data?.agents ?? [];
  const nodes = treeData?.nodes ?? [];
  const board = boardData?.board ?? {};

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return (
    <div className="space-y-4">
      {nodes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t.instAgents} — Tree</CardTitle></CardHeader>
          <CardContent>
            <div className="font-mono text-xs space-y-0.5">
              {nodes.filter(n => !n.parentId).map(root => (
                <AgentTreeNode key={root.id} node={root} nodeMap={nodeMap} depth={0} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {agents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t.agentsNoAgents}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {agents.map((agentId) => {
            const node = nodeMap.get(agentId);
            const agentBoard = board[agentId] ?? {};
            const isRunning = !!agentBoard.status || nodes.some(n => n.id === agentId);
            return (
              <Card key={agentId} className="transition-colors hover:border-primary/50">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono">{agentId}</CardTitle>
                    <div className="flex items-center gap-1.5">
                      {node?.role && <Badge variant="outline" className="text-xs">{node.role}</Badge>}
                      <Badge variant={isRunning ? "success" : "secondary"} className="text-xs">
                        {isRunning ? t.agentRunning : t.agentIdle}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {Object.keys(agentBoard).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(agentBoard).slice(0, 4).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="text-xs">
                          {k}: {typeof v === "string" ? v.slice(0, 20) : JSON.stringify(v)?.slice(0, 20)}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => navigate(`/admin/instances/${instanceId}/monitor/${agentId}`)}>
                      <Activity className="h-3 w-3" /> {t.agentMonitor}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Link to={`/admin/instances/${instanceId}/capabilities`}>
          <Button size="sm" variant="outline"><Puzzle className="h-3 w-3" /> {t.navCapabilities}</Button>
        </Link>
        <Link to={`/admin/instances/${instanceId}/skills`}>
          <Button size="sm" variant="outline"><Sparkles className="h-3 w-3" /> {t.navSkills}</Button>
        </Link>
        <Link to={`/admin/instances/${instanceId}/templates`}>
          <Button size="sm" variant="outline"><LayoutTemplate className="h-3 w-3" /> Templates</Button>
        </Link>
      </div>
    </div>
  );
}

function AgentTreeNode({ node, nodeMap, depth }: {
  node: { id: string; role?: string; children?: string[] };
  nodeMap: Map<string, { id: string; role?: string; parentId?: string | null; children?: string[] }>;
  depth: number;
}) {
  const indent = "  ".repeat(depth);
  const prefix = depth > 0 ? "├─ " : "";
  const children = (node.children ?? []).map(id => nodeMap.get(id)).filter(Boolean);
  return (
    <>
      <div>
        <span className="text-muted-foreground">{indent}{prefix}</span>
        <span className="text-foreground">{node.id}</span>
        {node.role && <span className="text-muted-foreground ml-1">({node.role})</span>}
      </div>
      {children.map(child => (
        <AgentTreeNode key={child!.id} node={child!} nodeMap={nodeMap} depth={depth + 1} />
      ))}
    </>
  );
}

function SessionsTab({ instanceId, t }: { instanceId: string; t: Messages }) {
  const [selectedAgent, setSelectedAgent] = useState("");

  const { data: agentsData } = useQuery<{ agents: string[] }>({
    queryKey: ["instances", instanceId, "agents"],
    queryFn: async () => {
      const nodes = await api.cmdQuery<Array<{ id: string }>>(instanceId, "list_agents");
      return { agents: nodes.map((n) => n.id) };
    },
  });

  const { data: sessionsData } = useQuery<{ sessions: string[] }>({
    queryKey: ["instances", instanceId, "sessions", selectedAgent],
    queryFn: () => api.cmdQuery<{ sessions: string[] }>(instanceId, "list_sessions", [selectedAgent]),
    enabled: !!selectedAgent,
  });

  const { data: events } = useQuery<string>({
    queryKey: ["instances", instanceId, "events", selectedAgent],
    queryFn: () => api.cmdQuery<string>(instanceId, "fetch_session_events", [selectedAgent]),
    enabled: !!selectedAgent,
    refetchInterval: 3000,
  });

  const agents = agentsData?.agents ?? [];
  const sessions = sessionsData?.sessions ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>{t.instSessions}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t.agentsSelectAgent}</Label>
            <Select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
              <option value="">{t.agentsChoose}</option>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </div>

          {selectedAgent && sessions.length > 0 && (
            <div className="space-y-2">
              <Label>{t.instSessions} ({sessions.length})</Label>
              {sessions.map((s) => (
                <div key={s} className="rounded-md border p-3">
                  <span className="font-mono text-sm">{s}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selectedAgent && events && (
        <Card>
          <CardHeader><CardTitle>{t.agentsEvents}</CardTitle></CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs font-mono whitespace-pre-wrap">
              {events || t.agentsNoEvents}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
