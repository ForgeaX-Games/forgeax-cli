/** Shared types for the Admin UI */

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

export interface Instance {
  id: string;
  status: string;
  statusMessage?: string;
  autoStart: boolean;
  createdAt: string;
  portMappings: PortMapping[];
}

export interface InstanceDetail extends Instance {
  instanceDir: string;
}

export interface TeamInfo {
  team: {
    teamId: string;
    source: { type: string; id: string; version: string };
    defaultAgent?: string;
    createdAt: string;
  } | null;
  backups: string[];
}

export interface PackMeta {
  id: string;
  name?: string;
  version?: string;
  description?: string;
}

export interface HealthData {
  status: string;
  uptime: number;
  instances: { id: string; status: string }[];
}

export interface LlmSection {
  api_key: string;
  api: string;
  api_base?: string;
  models: string[];
}

export interface ModelSpec {
  input: string[];
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  defaultTemperature: number;
}

// ── Status display helpers ──

export function displayStatus(s: string): string {
  if (s === "idle") return "no team";
  if (s === "unloaded") return "stopped";
  if (s === "starting") return "starting...";
  return s;
}

export function statusVariant(s: string): "success" | "secondary" | "destructive" | "warning" {
  const ds = displayStatus(s);
  switch (ds) {
    case "running": return "success";
    case "stopped": return "secondary";
    case "error": return "destructive";
    case "no team": return "warning";
    default: return "warning";
  }
}

// ── Introspection types ──

export type { StoredEvent } from "./event-engine/types";

export interface CapabilityItem {
  name: string;
  path: string;
  size?: number;
}

export interface CapabilityPackageSummary {
  name: string;
  kinds: { tools: string[]; slots: string[]; plugins: string[] };
}

export interface CapabilityLayer {
  id: string;
  packages: CapabilityPackageSummary[];
}

export interface CapabilitiesIntrospection {
  layers: CapabilityLayer[];
  agents: Record<string, { packages: CapabilityPackageSummary[]; config: Record<string, unknown> }>;
}

export interface CapabilityPackageDetail {
  name: string;
  layers: string[];
  items: { tools: CapabilityItem[]; slots: CapabilityItem[]; plugins: CapabilityItem[] };
}

export interface SkillSummary {
  name: string;
  description?: string;
  hasSkillMd: boolean;
}

export interface SkillLayer {
  id: string;
  skills: SkillSummary[];
}

export interface SkillsIntrospection {
  layers: SkillLayer[];
  agents: Record<string, { skills: SkillSummary[] }>;
}

export interface TemplateSummary {
  name: string;
  files: string[];
  hasCapabilities: boolean;
}

export interface TemplateLayer {
  id: string;
  templates: TemplateSummary[];
}

export interface TemplatesIntrospection {
  layers: TemplateLayer[];
}

export interface TemplateDetail {
  name: string;
  agentJson: Record<string, unknown> | null;
  soulMd: string | null;
  principleMd: string | null;
  files: string[];
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

export interface AgentNodeData {
  id: string;
  role?: string;
  parentId?: string | null;
  children?: string[];
}

export interface ChannelRecord {
  channelId: string;
  type: string;
  instanceId: string;
  agentId?: string;
  lifecycle: Array<{ event: string; ts: number; payload?: Record<string, unknown> }>;
}
