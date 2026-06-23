import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Plus, Download, Hammer, Trash2 } from "lucide-react";

interface PackMeta {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  hasDockerfile: boolean;
  isBuilt: boolean;
}

export default function Packs() {
  const t = useT();
  const qc = useQueryClient();
  const [installOpen, setInstallOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [newPack, setNewPack] = useState({ id: "", name: "", description: "" });

  const { data, isLoading } = useQuery<{ packs: PackMeta[] }>({
    queryKey: ["packs"],
    queryFn: () => api.get("/api/packs"),
  });

  const installMutation = useMutation({
    mutationFn: (src: string) => api.post("/api/packs/install", { source: src }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["packs"] }); setInstallOpen(false); setSource(""); },
  });

  const createMutation = useMutation({
    mutationFn: (p: typeof newPack) => api.post("/api/packs/create", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["packs"] }); setCreateOpen(false); setNewPack({ id: "", name: "", description: "" }); },
  });

  const buildMutation = useMutation({
    mutationFn: (packId: string) => api.post(`/api/packs/${packId}/build`, { docker: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["packs"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (packId: string) => api.del(`/api/packs/${packId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["packs"] }),
  });

  const packs = data?.packs ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t.packsTitle}</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
            <Download className="h-4 w-4" /> {t.packsInstall}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> {t.packsCreate}
          </Button>
        </div>
      </div>

      {isLoading && <LoadingState />}

      {!isLoading && packs.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t.packsEmpty}
          </CardContent>
        </Card>
      )}

      {packs.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.packsId}</TableHead>
                <TableHead>{t.packsName}</TableHead>
                <TableHead>{t.packsVersion}</TableHead>
                <TableHead>{t.packsDescription}</TableHead>
                <TableHead>{t.packsDocker}</TableHead>
                <TableHead>{t.packsBuilt}</TableHead>
                <TableHead className="text-right">{t.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono font-medium">{p.id}</TableCell>
                  <TableCell>{p.name || "-"}</TableCell>
                  <TableCell>{p.version || "-"}</TableCell>
                  <TableCell className="max-w-48 truncate">{p.description || "-"}</TableCell>
                  <TableCell>{p.hasDockerfile ? <Badge variant="outline">Dockerfile</Badge> : "-"}</TableCell>
                  <TableCell>{p.isBuilt ? <Badge variant="success">{t.packsBuilt}</Badge> : <Badge variant="secondary">{t.packsNotBuilt}</Badge>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => buildMutation.mutate(p.id)} disabled={buildMutation.isPending} aria-label={`${t.packsBuild} ${p.id}`}>
                        <Hammer className="h-3 w-3" /> {t.packsBuild}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(p.id)} aria-label={`${t.delete} ${p.id}`}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={installOpen} onClose={() => setInstallOpen(false)}>
        <DialogHeader><DialogTitle>{t.packsInstallTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>{t.packsSource}</Label>
          <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://... or /path/to/pack" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setInstallOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => installMutation.mutate(source)} disabled={!source.trim() || installMutation.isPending}>
            {installMutation.isPending ? t.packsInstalling : t.packsInstall}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <DialogHeader><DialogTitle>{t.packsCreateTitle}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>{t.packsPackId}</Label><Input value={newPack.id} onChange={(e) => setNewPack({ ...newPack, id: e.target.value })} placeholder="my-pack" /></div>
          <div><Label>{t.packsName}</Label><Input value={newPack.name} onChange={(e) => setNewPack({ ...newPack, name: e.target.value })} placeholder="My Pack" /></div>
          <div><Label>{t.packsDescription}</Label><Input value={newPack.description} onChange={(e) => setNewPack({ ...newPack, description: e.target.value })} placeholder="A brief description" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => createMutation.mutate(newPack)} disabled={!newPack.id.trim() || createMutation.isPending}>
            {createMutation.isPending ? t.packsCreating : t.packsCreate}
          </Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); setDeleteTarget(null); }} title={t.packsDeleteTitle} confirmText={t.delete}>
        <p>{t.delete} <strong>"{deleteTarget}"</strong>? {t.packsDeleteConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}
