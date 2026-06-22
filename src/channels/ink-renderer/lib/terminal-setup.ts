/**
 * Terminal key-binding management for Cursor / VS Code integrated terminals.
 *
 * Provides install, uninstall, and status-check for the two bindings that
 * enable Shift+Enter (newline) and Ctrl+Enter (steer submit) inside the
 * ink-renderer input box.
 *
 * Non-VS-Code terminals (Ghostty, Kitty, iTerm2, WezTerm, etc.) handle
 * these natively via the Kitty keyboard protocol and need no setup.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { rendererCacheStore } from "./renderer-cache-store.js";

// ── Binding definitions ──

export const SHIFT_ENTER_BINDING = {
  key: "shift+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: "\u001b\r" },
  when: "terminalFocus",
};

export const CTRL_ENTER_BINDING = {
  key: "ctrl+enter",
  command: "workbench.action.terminal.sendSequence",
  args: { text: "\u001b[13;5u" },
  when: "terminalFocus",
};

const MANAGED_BINDINGS = [SHIFT_ENTER_BINDING, CTRL_ENTER_BINDING];

// ── Path resolution ──

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (!fs.existsSync("/proc/version")) return false;
    const ver = fs.readFileSync("/proc/version", "utf-8");
    return /microsoft|wsl/i.test(ver);
  } catch { return false; }
}

function getWslWindowsCandidates(): string[] {
  const vscodeCwd = process.env.VSCODE_CWD ?? "";
  const mntMatch = vscodeCwd.match(/^(\/mnt\/[a-z])\//);
  const drive = mntMatch ? mntMatch[1] : "/mnt/c";

  const results: string[] = [];
  const usersDir = `${drive}/Users`;
  const skip = new Set(["Public", "Default", "Default User", "All Users"]);
  try {
    if (!fs.existsSync(usersDir)) return results;
    for (const name of fs.readdirSync(usersDir)) {
      if (skip.has(name)) continue;
      const appData = path.join(usersDir, name, "AppData", "Roaming");
      if (!fs.existsSync(appData)) continue;
      results.push(
        path.join(appData, "Cursor", "User", "keybindings.json"),
        path.join(appData, "Code", "User", "keybindings.json"),
      );
    }
  } catch { /* ignore */ }
  return results;
}

export function getKeybindingsPath(): string | null {
  const home = os.homedir();
  const platform = process.platform;

  const candidates: string[] = [];

  if (platform === "linux") {
    if (isWsl()) {
      candidates.push(...getWslWindowsCandidates());
    }
    candidates.push(
      path.join(home, ".config", "Cursor", "User", "keybindings.json"),
      path.join(home, ".config", "Code", "User", "keybindings.json"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Cursor", "User", "keybindings.json"),
      path.join(home, "Library", "Application Support", "Code", "User", "keybindings.json"),
    );
  } else if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    candidates.push(
      path.join(appData, "Cursor", "User", "keybindings.json"),
      path.join(appData, "Code", "User", "keybindings.json"),
    );
  }

  for (const p of candidates) {
    try {
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Internal helpers ──

function readBindings(kbPath: string): unknown[] {
  try {
    if (!fs.existsSync(kbPath)) return [];
    const raw = fs.readFileSync(kbPath, "utf-8");
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBindings(kbPath: string, bindings: unknown[]): void {
  const dir = path.dirname(kbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kbPath, JSON.stringify(bindings, null, 2) + "\n", "utf-8");
}

function matchesBinding(entry: any, binding: { key: string; command: string }): boolean {
  return (
    entry &&
    entry.key === binding.key &&
    entry.command === binding.command &&
    entry.when === "terminalFocus"
  );
}

// ── Status check ──

function detectVscodeTerminal(): boolean {
  if (process.env.TERM_PROGRAM === "vscode") return true;
  // WSL remote: TERM_PROGRAM is empty but VSCODE_IPC_HOOK_CLI is set
  return !!process.env.VSCODE_IPC_HOOK_CLI;
}

export interface TerminalSetupStatus {
  isVscodeTerminal: boolean;
  kbPath: string | null;
  shiftEnterInstalled: boolean;
  ctrlEnterInstalled: boolean;
  allInstalled: boolean;
}

export function checkSetupStatus(): TerminalSetupStatus {
  const isVscodeTerminal = detectVscodeTerminal();
  const kbPath = getKeybindingsPath();

  if (!kbPath) {
    return { isVscodeTerminal, kbPath, shiftEnterInstalled: false, ctrlEnterInstalled: false, allInstalled: false };
  }

  const bindings = readBindings(kbPath);
  const shiftEnterInstalled = bindings.some((b: any) => matchesBinding(b, SHIFT_ENTER_BINDING));
  const ctrlEnterInstalled = bindings.some((b: any) => matchesBinding(b, CTRL_ENTER_BINDING));

  return {
    isVscodeTerminal,
    kbPath,
    shiftEnterInstalled,
    ctrlEnterInstalled,
    allInstalled: shiftEnterInstalled && ctrlEnterInstalled,
  };
}

// ── Install ──

export interface SetupResult {
  installed: string[];
  skipped: string[];
  error?: string;
}

export function installKeybindings(): SetupResult {
  const kbPath = getKeybindingsPath();
  if (!kbPath) {
    return { installed: [], skipped: [], error: "未找到 Cursor/VSCode 配置目录" };
  }

  const bindings = readBindings(kbPath);
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const managed of MANAGED_BINDINGS) {
    if (bindings.some((b: any) => matchesBinding(b, managed))) {
      skipped.push(managed.key);
    } else {
      bindings.push(managed);
      installed.push(managed.key);
    }
  }

  if (installed.length > 0) {
    try {
      writeBindings(kbPath, bindings);
    } catch (e: any) {
      return { installed: [], skipped, error: `写入失败: ${e.message}` };
    }
  }

  return { installed, skipped };
}

// ── Uninstall ──

export function uninstallKeybindings(): SetupResult {
  const kbPath = getKeybindingsPath();
  if (!kbPath) {
    return { installed: [], skipped: [], error: "未找到 Cursor/VSCode 配置目录" };
  }

  const bindings = readBindings(kbPath);
  const removed: string[] = [];
  const notFound: string[] = [];

  const filtered = bindings.filter((entry: any) => {
    for (const managed of MANAGED_BINDINGS) {
      if (matchesBinding(entry, managed)) {
        removed.push(managed.key);
        return false;
      }
    }
    return true;
  });

  for (const managed of MANAGED_BINDINGS) {
    if (!removed.includes(managed.key)) notFound.push(managed.key);
  }

  if (removed.length > 0) {
    try {
      writeBindings(kbPath, filtered);
    } catch (e: any) {
      return { installed: [], skipped: notFound, error: `写入失败: ${e.message}` };
    }
  }

  return { installed: removed, skipped: notFound };
}

// ── "Don't show again" persistence (stored in renderer cache) ──

export function isDismissed(): boolean {
  try { return !!rendererCacheStore.snapshot().terminalSetupDismissed; } catch { return false; }
}

export function setDismissed(dismissed: boolean): void {
  try {
    rendererCacheStore.update((cache) => {
      if (dismissed) cache.terminalSetupDismissed = true;
      else delete cache.terminalSetupDismissed;
    });
    rendererCacheStore.flushSync();
  } catch { /* ignore */ }
}

// ── Terminal type detection ──

const NATIVE_EXTENDED_TERMINALS = ["ghostty", "iTerm.app", "kitty", "WezTerm", "WarpTerminal"];

export function isNativeExtendedKeyTerminal(): boolean {
  return NATIVE_EXTENDED_TERMINALS.includes(process.env.TERM_PROGRAM ?? "");
}

/**
 * Detects Cursor/VSCode Remote SSH (dev-cloud) sessions where the IDE
 * runs on the user's local machine and only a server is present here,
 * so keybindings.json cannot be written from this side.
 */
export function isRemoteSsh(): boolean {
  if (!detectVscodeTerminal()) return false;
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/**
 * Human-readable instructions for installing the two keybindings manually
 * on the local machine, used when auto-install cannot work (e.g. Remote SSH).
 */
export function buildManualInstallInstructions(): string {
  const snippet = JSON.stringify([SHIFT_ENTER_BINDING, CTRL_ENTER_BINDING], null, 2);
  // First line is the only line visible when ink-renderer collapses this
  // system message (MessageRow.SystemLine takes text.split("\n")[0]). It
  // must convey "next step exists, expand to see it" — not a dead "无法..."
  // signal that reads like a hard stop.
  return [
    "远程 Cursor — 快捷键需在本机配置，展开查看步骤",
    "",
    "Cursor 的快捷键需在本机安装，而不是远程服务器。",
    "",
    "安装 Shift+Enter / Ctrl+Enter 快捷键：",
    "  1. 在本机打开 Cursor（断开 Remote 或新开本机窗口）",
    "  2. 打开命令面板（Cmd/Ctrl+Shift+P）→ 执行 \"Preferences: Open Keyboard Shortcuts (JSON)\"",
    "  3. 把以下两条绑定加入顶层 JSON 数组（文件本身必须是 JSON 数组）：",
    "",
    snippet,
    "",
    "保存即可生效。之后再执行 /terminal-setup 可查看状态。",
  ].join("\n");
}

export function needsSetup(): boolean {
  if (!detectVscodeTerminal()) return false;
  if (isDismissed()) return false;
  return !checkSetupStatus().allInstalled;
}
