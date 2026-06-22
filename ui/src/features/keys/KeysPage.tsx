import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import type { LlmSection, ModelSpec } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Plus, Pencil, Trash2, Zap } from "lucide-react";

export default function Keys() {
  const t = useT();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.keysTitle}</h1>
      <Tabs defaultValue="llm">
        <TabsList>
          <TabsTrigger value="llm">{t.keysLlm}</TabsTrigger>
          <TabsTrigger value="models">{t.keysModels}</TabsTrigger>
          <TabsTrigger value="tools">{t.keysTools}</TabsTrigger>
        </TabsList>
        <TabsContent value="llm"><LlmKeysTab /></TabsContent>
        <TabsContent value="models"><ModelsTab /></TabsContent>
        <TabsContent value="tools"><ToolKeysTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function LlmKeysTab() {
  const t = useT();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editSection, setEditSection] = useState("");
  const [editData, setEditData] = useState({ api_key: "", api: "google-gemini-2", api_base: "", models: "" });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Record<string, LlmSection>>({
    queryKey: ["keys", "llm"],
    queryFn: () => api.get("/api/keys/llm"),
  });

  const saveMutation = useMutation({
    mutationFn: ({ section, isNew, ...body }: { section: string; isNew: boolean; api_key: string; api: string; api_base?: string; models: string[] }) =>
      isNew ? api.post("/api/keys/llm", { section, ...body }) : api.put(`/api/keys/llm/${section}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["keys", "llm"] }); setEditOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (section: string) => api.del(`/api/keys/llm/${section}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", "llm"] }),
  });

  const testMutation = useMutation({
    mutationFn: (section: string) => api.post<{ ok: boolean; error?: string; latencyMs?: number }>(`/api/keys/llm/${section}/test`),
  });

  const openAdd = () => { setEditSection(""); setEditData({ api_key: "", api: "google-gemini-2", api_base: "", models: "" }); setEditOpen(true); };
  const openEdit = (section: string, d: LlmSection) => { setEditSection(section); setEditData({ api_key: "", api: d.api, api_base: d.api_base || "", models: d.models.join(", ") }); setEditOpen(true); };

  const handleSave = () => {
    const isNew = editSection === "";
    const sectionName = isNew ? editData.api : editSection;
    saveMutation.mutate({ section: sectionName, isNew, api_key: editData.api_key, api: editData.api, api_base: editData.api_base || undefined, models: editData.models.split(",").map((m) => m.trim()).filter(Boolean) });
  };

  const sections = data ? Object.entries(data) : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4" /> {t.keysAddSection}</Button>
      </div>
      {isLoading && <LoadingState />}
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map(([section, d]) => (
          <Card key={section}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base font-mono">{section}</CardTitle>
              <Badge variant="outline">{d.api}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {d.models.map((m) => <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>)}
              </div>
              <div className="text-sm text-muted-foreground font-mono">{d.api_key}</div>
              {d.api_base && <div className="text-xs text-muted-foreground">{d.api_base}</div>}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => openEdit(section, d)}>
                  <Pencil className="h-3 w-3" /> {t.edit}
                </Button>
                <Button size="sm" variant="outline" onClick={() => testMutation.mutate(section)} disabled={testMutation.isPending}>
                  <Zap className="h-3 w-3" /> {
                    testMutation.isPending ? t.keysTesting :
                    testMutation.data?.ok === true ? `OK (${testMutation.data.latencyMs}ms)` :
                    testMutation.data?.ok === false ? t.keysFailed : t.keysTest
                  }
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(section)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)}>
        <DialogHeader>
          <DialogTitle>{editSection ? `${t.edit}: ${editSection}` : t.keysAddLlm}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!editSection && (
            <div><Label>{t.keysSectionName}</Label><Input value={editData.api} onChange={(e) => setEditData({ ...editData, api: e.target.value })} placeholder="section-name" /></div>
          )}
          <div>
            <Label>{t.keysAdapter}</Label>
            <Select value={editData.api} onChange={(e) => setEditData({ ...editData, api: e.target.value })}>
              <option value="google-gemini-2">google-gemini-2</option>
              <option value="google-gemini-3">google-gemini-3</option>
              <option value="anthropic-messages">anthropic-messages</option>
              <option value="openai-completions">openai-completions</option>
              <option value="deepseek">deepseek</option>
            </Select>
          </div>
          <div><Label>{t.keysApiKey}</Label><Input type="password" value={editData.api_key} onChange={(e) => setEditData({ ...editData, api_key: e.target.value })} placeholder={editSection ? t.keysKeepCurrent : t.keysEnterKey} /></div>
          <div><Label>{t.keysApiBase}</Label><Input value={editData.api_base} onChange={(e) => setEditData({ ...editData, api_base: e.target.value })} placeholder="https://api.example.com" /></div>
          <div><Label>{t.keysModelsLabel}</Label><Input value={editData.models} onChange={(e) => setEditData({ ...editData, models: e.target.value })} placeholder="model-1, model-2" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditOpen(false)}>{t.cancel}</Button>
          <Button onClick={handleSave} disabled={saveMutation.isPending}>{saveMutation.isPending ? t.saving : t.save}</Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); setDeleteTarget(null); }} title={t.keysDeleteSection} confirmText={t.delete}>
        <p>{t.delete} <strong>"{deleteTarget}"</strong>? {t.keysDeleteConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}

function ModelsTab() {
  const t = useT();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [editData, setEditData] = useState({ inputText: "text", reasoning: false, contextWindow: 128000, maxOutput: 8192, defaultTemperature: 1 });

  const { data, isLoading } = useQuery<Record<string, ModelSpec>>({
    queryKey: ["models"],
    queryFn: () => api.get("/api/models"),
  });

  const saveMutation = useMutation({
    mutationFn: ({ name, spec }: { name: string; spec: ModelSpec }) => api.put(`/api/models/${name}`, spec),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["models"] }); setEditOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => api.del(`/api/models/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });

  const openAdd = () => { setEditName(""); setIsNew(true); setEditData({ inputText: "text", reasoning: false, contextWindow: 128000, maxOutput: 8192, defaultTemperature: 1 }); setEditOpen(true); };
  const openEdit = (name: string, spec: ModelSpec) => { setEditName(name); setIsNew(false); setEditData({ inputText: spec.input.join(", "), reasoning: spec.reasoning, contextWindow: spec.contextWindow, maxOutput: spec.maxOutput, defaultTemperature: spec.defaultTemperature }); setEditOpen(true); };

  const handleSave = () => {
    saveMutation.mutate({ name: editName, spec: { input: editData.inputText.split(",").map((s) => s.trim()).filter(Boolean), reasoning: editData.reasoning, contextWindow: editData.contextWindow, maxOutput: editData.maxOutput, defaultTemperature: editData.defaultTemperature } });
  };

  const models = data ? Object.entries(data) : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4" /> {t.keysAddModel}</Button>
      </div>
      {isLoading && <LoadingState />}
      {models.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.keysModels}</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>{t.keysReasoning}</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>{t.keysMaxOutput}</TableHead>
                <TableHead>Temp</TableHead>
                <TableHead className="text-right">{t.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map(([name, spec]) => (
                <TableRow key={name}>
                  <TableCell className="font-mono font-medium">{name}</TableCell>
                  <TableCell><div className="flex gap-1">{spec.input.map((i) => <Badge key={i} variant="secondary" className="text-xs">{i}</Badge>)}</div></TableCell>
                  <TableCell>{spec.reasoning ? t.yes : t.no}</TableCell>
                  <TableCell>{(spec.contextWindow / 1000).toFixed(0)}K</TableCell>
                  <TableCell>{(spec.maxOutput / 1000).toFixed(0)}K</TableCell>
                  <TableCell>{spec.defaultTemperature}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => openEdit(name, spec)} aria-label={`${t.edit} ${name}`}><Pencil className="h-3 w-3" /></Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(name)} aria-label={`${t.delete} ${name}`}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={editOpen} onClose={() => setEditOpen(false)}>
        <DialogHeader><DialogTitle>{isNew ? t.keysAddModel : `${t.edit}: ${editName}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>{t.keysModelName}</Label><Input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={!isNew} placeholder="model-name" /></div>
          <div><Label>{t.keysInputModalities}</Label><Input value={editData.inputText} onChange={(e) => setEditData({ ...editData, inputText: e.target.value })} placeholder="text, image, video, audio" /></div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="reasoning" checked={editData.reasoning} onChange={(e) => setEditData({ ...editData, reasoning: e.target.checked })} />
            <Label htmlFor="reasoning">{t.keysReasoning}</Label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>{t.keysContextWindow}</Label><Input type="number" value={editData.contextWindow} onChange={(e) => setEditData({ ...editData, contextWindow: +e.target.value })} /></div>
            <div><Label>{t.keysMaxOutput}</Label><Input type="number" value={editData.maxOutput} onChange={(e) => setEditData({ ...editData, maxOutput: +e.target.value })} /></div>
            <div><Label>{t.keysDefaultTemp}</Label><Input type="number" step="0.1" value={editData.defaultTemperature} onChange={(e) => setEditData({ ...editData, defaultTemperature: +e.target.value })} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditOpen(false)}>{t.cancel}</Button>
          <Button onClick={handleSave} disabled={!editName || saveMutation.isPending}>{saveMutation.isPending ? t.saving : t.save}</Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); setDeleteTarget(null); }} title={t.keysDeleteModel} confirmText={t.delete}>
        <p>{t.delete} <strong>"{deleteTarget}"</strong>? {t.keysDeleteConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}

function ToolKeysTab() {
  const t = useT();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Record<string, string>>({
    queryKey: ["keys", "tools"],
    queryFn: () => api.get("/api/keys/tools"),
  });

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      isNew ? api.post("/api/keys/tools", { key, value }) : api.put(`/api/keys/tools/${key}`, { value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["keys", "tools"] }); setEditOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => api.del(`/api/keys/tools/${key}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", "tools"] }),
  });

  const openAdd = () => { setEditKey(""); setEditValue(""); setIsNew(true); setEditOpen(true); };
  const openEdit = (key: string) => { setEditKey(key); setEditValue(""); setIsNew(false); setEditOpen(true); };

  const tools = data ? Object.entries(data) : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4" /> {t.keysAddKey}</Button>
      </div>
      {isLoading && <LoadingState />}
      {tools.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.keysKeyName}</TableHead>
                <TableHead>{t.keysValue}</TableHead>
                <TableHead className="text-right">{t.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="font-mono font-medium">{key}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {value || <span className="text-warning">{t.notConfigured}</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => openEdit(key)} aria-label={`${t.edit} ${key}`}><Pencil className="h-3 w-3" /></Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(key)} aria-label={`${t.delete} ${key}`}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={editOpen} onClose={() => setEditOpen(false)}>
        <DialogHeader><DialogTitle>{isNew ? t.keysAddToolKey : `${t.edit}: ${editKey}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>{t.keysKeyName}</Label><Input value={editKey} onChange={(e) => setEditKey(e.target.value)} disabled={!isNew} placeholder="my_api_key" /></div>
          <div><Label>{t.keysValue}</Label><Input type="password" value={editValue} onChange={(e) => setEditValue(e.target.value)} placeholder={isNew ? t.keysEnterValue : t.keysEnterNewValue} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditOpen(false)}>{t.cancel}</Button>
          <Button onClick={() => saveMutation.mutate({ key: editKey, value: editValue })} disabled={!editKey || !editValue || saveMutation.isPending}>
            {saveMutation.isPending ? t.saving : t.save}
          </Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); setDeleteTarget(null); }} title={t.keysDeleteKey} confirmText={t.delete}>
        <p>{t.delete} <strong>"{deleteTarget}"</strong>? {t.keysDeleteConfirm}</p>
      </ConfirmDialog>
    </div>
  );
}
