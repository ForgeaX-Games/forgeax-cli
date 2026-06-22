// @desc Slash command registry — shared metadata + handler keys for suggestions and routing
import type { SlashCommand } from "../types.js";
import type { CommandSpec } from "../../../capability/command/types.js";

export type SlashCommandHandlerKey =
  | "agents"
  | "model"
  | "instance"
  | "delete-agent"
  | "delete-instance"
  | "clean-image"
  | "rm-containers"
  | "sync-pack"
  | "load-pack"
  | "restore"
  | "terminal-setup"
  | "board"
  | "restart-instance"
  | "agent-command";

export interface SlashCommandSpec extends SlashCommand {
  aliases?: readonly string[];
  handler: SlashCommandHandlerKey;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: "agents",           aliases: ["agent"],  description: "切换 Agent（树视图，实时刷新）", handler: "agents" },
  { name: "model",            aliases: ["models"], description: "切换当前 agent 的模型 (写入 agent-overrides.json)", handler: "model" },
  { name: "instance",         aliases: ["instances"], description: "切换/新建 Instance", handler: "instance" },
  { name: "delete-agent",     description: "删除当前 Agent（不可恢复）", handler: "delete-agent" },
  { name: "delete-instance",  description: "删除 Instance（不可恢复）", handler: "delete-instance" },
  { name: "terminal-setup",   description: "安装/卸载终端快捷键 (Shift+Enter, Ctrl+Enter)", handler: "terminal-setup" },
  { name: "help",             description: "显示帮助信息", handler: "agent-command" },
  { name: "board",            description: "Teamboard 协作面板", handler: "board" },
  { name: "clean-image",      description: "删除 Pack 的 Docker 镜像", handler: "clean-image" },
  { name: "rm-containers",    description: "删除 Instance 的全部容器", handler: "rm-containers" },
  { name: "sync-pack",        description: "同步 Team 变更到 Pack（patch +1）", handler: "sync-pack" },
  { name: "load-pack",        description: "加载 Pack 到 Instance（覆盖 team）", handler: "load-pack" },
  { name: "restore",          description: "恢复 Instance 的 Team 备份", handler: "restore" },
  { name: "restart_instance", description: "重启实例以应用改动（走 Gateway HTTP）", handler: "restart-instance" },
];

function normalizeCommandName(input: string): string {
  return input.trim().replace(/^\/+/, "").toLowerCase();
}

function matchesSpec(spec: SlashCommandSpec, name: string): boolean {
  return spec.name === name || !!spec.aliases?.includes(name);
}

/**
 * Suggest commands for an autocomplete prefix. Merges built-in SLASH_COMMANDS
 * with optional remote commands (from `useRemoteCommands` — i.e. the worker
 * `list_commands` poll). Same-name conflict: local wins (matches the route
 * dispatch decision in `useSlashCommands` where `spec !== null` is checked
 * before worker fallback).
 *
 * Synthetic specs whose name starts with `_error:` are filtered — they are
 * diagnostic markers from broken command modules, not user-facing commands.
 */
export function getSlashCommandSuggestions(
  prefix: string,
  remoteCommands: readonly CommandSpec[] = [],
): SlashCommand[] {
  const normalized = normalizeCommandName(prefix);
  const localNames = new Set<string>(SLASH_COMMANDS.map(s => s.name));
  for (const spec of SLASH_COMMANDS) {
    if (spec.aliases) for (const a of spec.aliases) localNames.add(a);
  }

  const localMatches = (normalized
    ? SLASH_COMMANDS.filter(spec =>
        spec.name.startsWith(normalized) || !!spec.aliases?.some(alias => alias.startsWith(normalized)),
      )
    : SLASH_COMMANDS
  ).map(({ name, description }) => ({ name, description }));

  const remoteMatches: SlashCommand[] = [];
  for (const spec of remoteCommands) {
    if (spec.name.startsWith("_error:")) continue;     // skip diagnostic markers
    if (localNames.has(spec.name)) continue;            // local wins
    if (normalized && !spec.name.startsWith(normalized)) continue;
    remoteMatches.push({ name: spec.name, description: spec.description });
  }

  return [...localMatches, ...remoteMatches];
}

export function resolveSlashCommand(command: string): SlashCommandSpec | null {
  const name = normalizeCommandName(command.split(/\s+/, 1)[0] ?? "");
  if (!name) return null;
  return SLASH_COMMANDS.find(spec => matchesSpec(spec, name)) ?? null;
}
