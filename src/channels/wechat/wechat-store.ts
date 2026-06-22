// @desc WeChat account and sync-buf persistence in adapterCache("wechat")

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getSharedPaths } from "../../fs/state-dir.js";

export interface WechatAccountData {
  token: string;
  baseUrl: string;
  botId: string;
  userId?: string;
  savedAt: string;
}

function cacheDir(): string {
  return getSharedPaths().adapterCache("wechat");
}

function accountPath(): string {
  return join(cacheDir(), "account.json");
}

function syncBufPath(): string {
  return join(cacheDir(), "sync-buf.txt");
}

export function loadAccount(): WechatAccountData | null {
  try {
    const p = accountPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as WechatAccountData;
  } catch {
    return null;
  }
}

export function saveAccount(data: WechatAccountData): void {
  const p = accountPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function loadSyncBuf(): string {
  try {
    const p = syncBufPath();
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export function saveSyncBuf(buf: string): void {
  const p = syncBufPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf, "utf-8");
}

export function mediasDir(): string {
  return join(cacheDir(), "medias");
}

// ── Channel config (agentId etc.) ──

export interface WechatChannelConfig {
  agentId?: string;
  [key: string]: unknown;
}

function channelConfigPath(): string {
  return join(cacheDir(), "channel.json");
}

export function loadChannelConfig(): WechatChannelConfig {
  try {
    const p = channelConfigPath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as WechatChannelConfig;
  } catch {
    return {};
  }
}

export function saveChannelConfig(patch: Partial<WechatChannelConfig>): void {
  const p = channelConfigPath();
  let cfg = loadChannelConfig();
  cfg = { ...cfg, ...patch };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
}

// ── In-memory context token cache (with disk persistence) ──

const contextTokens = new Map<string, string>();

function contextTokensPath(): string {
  return join(cacheDir(), "context-tokens.json");
}

export function loadContextTokens(): Record<string, string> {
  try {
    const p = contextTokensPath();
    if (!existsSync(p)) return {};
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(data)) contextTokens.set(k, v);
    return data;
  } catch {
    return {};
  }
}

export function saveContextTokens(): void {
  const p = contextTokensPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(Object.fromEntries(contextTokens), null, 2), "utf-8");
}

export function setContextToken(fromUserId: string, token: string): void {
  contextTokens.set(fromUserId, token);
}

export function getContextToken(fromUserId: string): string | undefined {
  return contextTokens.get(fromUserId);
}

export function clearContextToken(fromUserId: string): void {
  contextTokens.delete(fromUserId);
  saveContextTokens();
}

// ── Reply targets persistence ──

function replyTargetsPath(): string {
  return join(cacheDir(), "reply-targets.json");
}

export function loadReplyTargets(): Record<string, string> {
  try {
    const p = replyTargetsPath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveReplyTargets(targets: Record<string, string>): void {
  const p = replyTargetsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(targets, null, 2), "utf-8");
}

// ── Pending outbound message queue (survives restarts) ──

export interface PendingMessage {
  id: string;
  to: string;
  text: string;
  enqueuedAt: number;
}

const MAX_PENDING_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_PENDING_PER_USER = 50;
const pendingQueues = new Map<string, PendingMessage[]>();

function pendingQueuePath(): string {
  return join(cacheDir(), "pending-messages.json");
}

function loadPendingQueues(): void {
  try {
    const p = pendingQueuePath();
    if (!existsSync(p)) return;
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, PendingMessage[]>;
    const now = Date.now();
    for (const [userId, msgs] of Object.entries(data)) {
      const valid = msgs.filter((m) => now - m.enqueuedAt < MAX_PENDING_AGE_MS);
      if (valid.length) pendingQueues.set(userId, valid);
    }
  } catch { /* best effort */ }
}

function savePendingQueues(): void {
  const p = pendingQueuePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(Object.fromEntries(pendingQueues), null, 2), "utf-8");
}

export function enqueuePending(to: string, text: string): void {
  let queue = pendingQueues.get(to) ?? [];
  queue.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, to, text, enqueuedAt: Date.now() });
  if (queue.length > MAX_PENDING_PER_USER) {
    queue = queue.slice(-MAX_PENDING_PER_USER);
  }
  pendingQueues.set(to, queue);
  savePendingQueues();
}

export function drainPending(to: string): PendingMessage[] {
  const queue = pendingQueues.get(to) ?? [];
  if (!queue.length) return [];
  const now = Date.now();
  const valid = queue.filter((m) => now - m.enqueuedAt < MAX_PENDING_AGE_MS);
  pendingQueues.delete(to);
  savePendingQueues();
  return valid;
}

// eagerly load persisted state on module init
loadContextTokens();
loadPendingQueues();
