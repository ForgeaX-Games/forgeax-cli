import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { InstanceDetail } from "@/lib/types";

export function useInstance(id: string) {
  return useQuery<InstanceDetail>({
    queryKey: ["instances", id],
    queryFn: () => api.get(`/api/instances/${id}`),
    refetchInterval: 3000,
  });
}
