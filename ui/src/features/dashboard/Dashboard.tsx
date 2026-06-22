import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { HealthData } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { Server, Clock, Activity } from "lucide-react";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function Dashboard() {
  const t = useT();
  const { data, isLoading, error } = useQuery<HealthData>({
    queryKey: ["health"],
    queryFn: () => api.get("/health"),
    refetchInterval: 5000,
  });

  if (isLoading) return <LoadingState />;

  if (error) {
    return (
      <div className="text-destructive">
        {t.dashConnectFailed} {(error as Error).message}
      </div>
    );
  }

  const running = data!.instances.filter((i) => i.status === "running").length;
  const total = data!.instances.length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.dashTitle}</h1>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t.dashStatus}</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <Badge variant="success">{data!.status}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t.dashUptime}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatUptime(data!.uptime)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t.dashInstances}</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{running} / {total}</div>
            <p className="text-xs text-muted-foreground">{t.dashRunningTotal}</p>
          </CardContent>
        </Card>
      </div>

      {data!.instances.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t.dashInstances}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data!.instances.map((inst) => (
                <div key={inst.id} className="flex items-center justify-between rounded-md border p-3">
                  <span className="font-medium">{inst.id}</span>
                  <Badge variant={inst.status === "running" ? "success" : inst.status === "stopped" ? "secondary" : "warning"}>
                    {inst.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
