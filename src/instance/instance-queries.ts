/**
 * @desc Instance query helpers — pure functions for reading instance data.
 *
 * Used by instance.ts handle methods. These run inside the worker process
 * and access the local filesystem / scheduler memory.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type {
  TeamInfoPayload,
  CapabilitiesIntrospection,
  CapabilityLayer,
  CapabilityPackageSummary,
  CapabilityPackageDetail,
  CapabilityItem,
  SkillsIntrospection,
  SkillSummary,
  SkillLayer,
  TemplatesIntrospection,
  TemplateLayer,
  TemplateSummary,
  TemplateDetail,
  BackupInfo,
  StoredEvent,
} from "../core/types.js";

export function getTeamInfo(instanceDir: string): { team: TeamInfoPayload | null; backups: string[] } {
  let team: TeamInfoPayload | null = null;
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      team = {
        teamId: raw.teamId,
        source: { type: raw.sourceType ?? raw.source?.type, id: raw.id ?? raw.source?.id, version: raw.version ?? raw.source?.version },
        ...(raw.default_agent ? { defaultAgent: raw.default_agent } : {}),
        createdAt: raw.createdAt,
      };
    } catch {}
  }

  const backups: string[] = [];
  const backupsDir = join(instanceDir, "backups");
  if (existsSync(backupsDir)) {
    for (const f of readdirSync(backupsDir)) {
      if (f.endsWith(".zip")) backups.push(f.replace(/\.zip$/, ""));
    }
  }

  return { team, backups };
}

export function getTeamManifest(instanceDir: string): Record<string, unknown> | null {
  const manifestPath = join(instanceDir, "team", "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { return null; }
}

// ─── Capabilities introspection ──────────────────────────────────────────────

function scanCapabilitiesDir(dir: string): CapabilityPackageSummary[] {
  if (!existsSync(dir)) return [];
  const packages: CapabilityPackageSummary[] = [];
  try {
    for (const pkg of readdirSync(dir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const pkgDir = join(dir, pkg.name);
      const kinds: CapabilityPackageSummary["kinds"] = { tools: [], slots: [], plugins: [] };
      for (const kind of ["tools", "slots", "plugins"] as const) {
        const kindDir = join(pkgDir, kind);
        if (!existsSync(kindDir)) continue;
        try {
          kinds[kind] = readdirSync(kindDir)
            .filter(f => f.endsWith(".ts") || f.endsWith(".js"))
            .map(f => f.replace(/\.(ts|js)$/, ""));
        } catch {}
      }
      packages.push({ name: pkg.name, kinds });
    }
  } catch {}
  return packages;
}

export function getCapabilities(instanceDir: string): CapabilitiesIntrospection {
  const layers: CapabilityLayer[] = [
    { id: "instance", packages: scanCapabilitiesDir(join(instanceDir, "capabilities")) },
    { id: "team", packages: scanCapabilitiesDir(join(instanceDir, "team", "capabilities")) },
  ];

  const agents: CapabilitiesIntrospection["agents"] = {};
  const agentsDir = join(instanceDir, "team", "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsDir, entry.name);
      if (!existsSync(join(agentDir, "agent.json"))) continue;
      const packages = scanCapabilitiesDir(join(agentDir, "capabilities"));
      let config: Record<string, unknown> = {};
      try {
        const agentJson = JSON.parse(readFileSync(join(agentDir, "agent.json"), "utf-8"));
        config = agentJson.capabilities ?? {};
      } catch {}
      agents[entry.name] = { packages, config };
    }
  }

  return { layers, agents };
}

function scanCapabilityPackageItems(dir: string, pkgName: string): CapabilityItem[] {
  const items: CapabilityItem[] = [];
  const pkgDir = join(dir, pkgName);
  if (!existsSync(pkgDir)) return items;
  for (const kind of ["tools", "slots", "plugins"]) {
    const kindDir = join(pkgDir, kind);
    if (!existsSync(kindDir)) continue;
    try {
      for (const f of readdirSync(kindDir)) {
        if (!(f.endsWith(".ts") || f.endsWith(".js"))) continue;
        const filePath = join(kindDir, f);
        try {
          const s = statSync(filePath);
          items.push({ name: f.replace(/\.(ts|js)$/, ""), path: `${kind}/${f}`, size: s.size });
        } catch {
          items.push({ name: f.replace(/\.(ts|js)$/, ""), path: `${kind}/${f}` });
        }
      }
    } catch {}
  }
  return items;
}

export function getCapabilityPackage(instanceDir: string, pkg: string): CapabilityPackageDetail | null {
  const capDirs = [
    { id: "instance", dir: join(instanceDir, "capabilities") },
    { id: "team", dir: join(instanceDir, "team", "capabilities") },
  ];

  const foundLayers: string[] = [];
  const items: CapabilityPackageDetail["items"] = { tools: [], slots: [], plugins: [] };

  for (const { id, dir } of capDirs) {
    if (existsSync(join(dir, pkg))) {
      foundLayers.push(id);
      for (const item of scanCapabilityPackageItems(dir, pkg)) {
        const kind = item.path.split("/")[0] as keyof typeof items;
        if (items[kind] && !items[kind].some(i => i.name === item.name)) {
          items[kind].push(item);
        }
      }
    }
  }

  if (foundLayers.length === 0) return null;
  return { name: pkg, layers: foundLayers, items };
}

// ─── Skills introspection ────────────────────────────────────────────────────

function scanSkillsDir(dir: string): SkillSummary[] {
  if (!existsSync(dir)) return [];
  const skills: SkillSummary[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const skillMd = join(skillDir, "SKILL.md");
      const hasSkillMd = existsSync(skillMd);
      let description: string | undefined;
      if (hasSkillMd) {
        try {
          const content = readFileSync(skillMd, "utf-8");
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const descMatch = fmMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
            if (descMatch) description = descMatch[1];
          }
        } catch {}
      }
      skills.push({ name: entry.name, description, hasSkillMd });
    }
  } catch {}
  return skills;
}

export function getSkills(instanceDir: string): SkillsIntrospection {
  const layers: SkillLayer[] = [
    { id: "team", skills: scanSkillsDir(join(instanceDir, "team", "skills")) },
  ];

  const agents: SkillsIntrospection["agents"] = {};
  const agentsDir = join(instanceDir, "team", "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(agentsDir, entry.name, "agent.json"))) continue;
      const skills = scanSkillsDir(join(agentsDir, entry.name, "skills"));
      agents[entry.name] = { skills };
    }
  }

  return { layers, agents };
}

export function getSkillContent(instanceDir: string, name: string): string | null {
  const candidates = [
    join(instanceDir, "team", "skills", name, "SKILL.md"),
  ];
  const agentsDir = join(instanceDir, "team", "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(agentsDir, entry.name, "skills", name, "SKILL.md"));
      }
    }
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, "utf-8"); } catch {}
    }
  }
  return null;
}

// ─── Templates introspection ─────────────────────────────────────────────────

function scanTemplatesDir(dir: string): TemplateSummary[] {
  if (!existsSync(dir)) return [];
  const templates: TemplateSummary[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tplDir = join(dir, entry.name);
      let files: string[] = [];
      try { files = readdirSync(tplDir).filter(f => !f.startsWith(".")); } catch {}
      const hasCapabilities = existsSync(join(tplDir, "capabilities"));
      templates.push({ name: entry.name, files, hasCapabilities });
    }
  } catch {}
  return templates;
}

export function getTemplates(instanceDir: string): TemplatesIntrospection {
  const layers: TemplateLayer[] = [
    { id: "instance", templates: scanTemplatesDir(join(instanceDir, "templates")) },
    { id: "team", templates: scanTemplatesDir(join(instanceDir, "team", "templates")) },
  ];

  const agentsDir = join(instanceDir, "team", "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(agentsDir, entry.name, "agent.json"))) continue;
      const templates = scanTemplatesDir(join(agentsDir, entry.name, "templates"));
      layers.push({ id: `agent:${entry.name}`, templates });
    }
  }

  return { layers };
}

export function getTemplateDetail(instanceDir: string, layer: string, name: string): TemplateDetail | null {
  let dir: string;
  if (layer === "instance") {
    dir = join(instanceDir, "templates", name);
  } else if (layer === "team") {
    dir = join(instanceDir, "team", "templates", name);
  } else if (layer.startsWith("agent:")) {
    const agentId = layer.slice("agent:".length);
    dir = join(instanceDir, "team", "agents", agentId, "templates", name);
  } else {
    return null;
  }

  if (!existsSync(dir)) return null;

  let agentJson: Record<string, unknown> | null = null;
  const ajPath = join(dir, "agent.json");
  if (existsSync(ajPath)) {
    try { agentJson = JSON.parse(readFileSync(ajPath, "utf-8")); } catch {}
  }

  let soulMd: string | null = null;
  const soulPath = join(dir, "SOUL.md");
  if (existsSync(soulPath)) {
    try { soulMd = readFileSync(soulPath, "utf-8"); } catch {}
  }

  let principleMd: string | null = null;
  const principlePath = join(dir, "PRINCIPLE.md");
  if (existsSync(principlePath)) {
    try { principleMd = readFileSync(principlePath, "utf-8"); } catch {}
  }

  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => !f.startsWith(".")); } catch {}

  return { name, agentJson, soulMd, principleMd, files };
}

// ─── Backups introspection ───────────────────────────────────────────────────

export function getBackups(instanceDir: string): BackupInfo[] {
  const backupsDir = join(instanceDir, "backups");
  if (!existsSync(backupsDir)) return [];
  const result: BackupInfo[] = [];
  try {
    for (const f of readdirSync(backupsDir)) {
      if (!f.endsWith(".zip")) continue;
      const filePath = join(backupsDir, f);
      try {
        const s = statSync(filePath);
        result.push({
          name: f.replace(/\.zip$/, ""),
          size: s.size,
          createdAt: s.mtime.toISOString(),
        });
      } catch {}
    }
  } catch {}
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

export function getBackupManifest(instanceDir: string, name: string): Record<string, unknown> | null {
  const zipPath = join(instanceDir, "backups", `${name}.zip`);
  if (!existsSync(zipPath)) return null;
  return { name, zipPath, exists: true };
}

// ─── Events JSONL ────────────────────────────────────────────────────────────

export function readEventsJsonl(instanceDir: string, agentId: string): StoredEvent[] {
  const agentSessionsDir = join(instanceDir, "team", "sessions", agentId);
  if (!existsSync(agentSessionsDir)) return [];

  const eventsDir = resolveActiveSessionDir(agentSessionsDir) ?? agentSessionsDir;

  const events: StoredEvent[] = [];
  try {
    const files = readdirSync(eventsDir)
      .filter(f => f.startsWith("events-") && f.endsWith(".jsonl"))
      .sort();
    for (const file of files) {
      const content = readFileSync(join(eventsDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    }
  } catch {}
  return events;
}

function resolveActiveSessionDir(agentSessionsDir: string): string | null {
  try {
    const raw = readFileSync(join(agentSessionsDir, "session.json"), "utf-8");
    const data = JSON.parse(raw) as { currentSessionId?: string };
    if (!data.currentSessionId) return null;
    const dir = join(agentSessionsDir, data.currentSessionId);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}
