import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "@/lib/api";
import type { Instance } from "@/lib/types";
import { displayStatus, statusVariant } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Plus, Play, Square, ChevronRight } from "lucide-react";

export default function InstanceList() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ instances: Instance[] }>({
    queryKey: ["instances"],
    queryFn: () => api.get("/api/instances"),
    refetchInterval: 3000,
  });

  const addMutation = useMutation({
    mutationFn: (id: string) => api.post("/api/instances", { id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["instances"] }); setAddOpen(false); setNewId(""); },
    onError: (e: any) => setActionError(e?.message ?? String(e)),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post(`/api/instances/${id}/${action}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["instances"] }); setActionError(null); },
    onError: (e: any) => setActionError(e?.message ?? String(e)),
  });

  const instances = data?.instances ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t.instTitle}</h1>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4" /> {t.instAdd}
        </Button>
      </div>

      {actionError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {actionError}
          <button className="ml-2 underline" onClick={() => setActionError(null)}>{t.dismiss}</button>
        </div>
      )}

      {isLoading && <LoadingState />}

      {!isLoading && instances.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t.instEmpty}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {instances.map((inst) => {
          const ds = displayStatus(inst.status);
          const canStart = ds === "stopped" || ds === "error";
          const canStop = ds === "running" || ds === "no team" || inst.status === "starting";

          return (
            <Card
              key={inst.id}
              className="cursor-pointer transition-colors hover:border-primary/50"
              onClick={() => navigate(`/admin/instances/${inst.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{inst.id}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(inst.status)}>{ds}</Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                {inst.createdAt && (
                  <CardDescription className="text-xs">
                    {t.instCreated} {new Date(inst.createdAt).toLocaleDateString()}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                {inst.statusMessage && (
                  <div className="mb-3 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
                    {inst.statusMessage}
                  </div>
                )}
                {inst.portMappings.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {inst.portMappings.map((p) => (
                      <Badge key={p.hostPort} variant="outline" className="text-xs">
                        {p.hostPort}→{p.containerPort}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                  {canStart && (
                    <Button size="sm" variant="outline" onClick={() => actionMutation.mutate({ id: inst.id, action: "start" })} disabled={actionMutation.isPending}>
                      <Play className="h-3 w-3" /> {t.instStart}
                    </Button>
                  )}
                  {canStop && (
                    <Button size="sm" variant="outline" onClick={() => actionMutation.mutate({ id: inst.id, action: "stop" })} disabled={actionMutation.isPending}>
                      <Square className="h-3 w-3" /> {t.instStop}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)}>
        <DialogHeader>
          <DialogTitle>{t.instAddTitle}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="inst-id">{t.instId}</Label>
            <Input id="inst-id" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="my-instance" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => addMutation.mutate(newId)} disabled={!newId.trim() || addMutation.isPending}>
            {addMutation.isPending ? t.instAdding : t.add}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
