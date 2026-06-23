/**
 * Phase C3 — cli-provider kind loader.
 *
 * Promotes the B2-era stub (a bare `{pluginId, manifest}` pointer) to a
 * structured CliProviderEntry that the Driver registry + SettingsPanel ·
 * CLI Providers (C7) consume directly. The real Driver instance is *not*
 * imported eagerly — `entry.backend` is recorded as a path and the loader
 * exposes a `loadDriver()` helper that dynamic-imports lazily on first
 * `chat()` use. Eager import would couple every cli-provider plugin to
 * server boot, defeating the L0/L1/L2 layering.
 *
 * Built-in forgeax-native is the exception: it's already in-tree and
 * registered by `bootCliProviders()`, so its plugin manifest can omit
 * `entry.backend` and the loader will short-circuit `loadDriver()` to the
 * already-registered driver from `@forgeax/agent-runtime`'s registry.
 */
import { dirname, resolve } from 'node:path';
import type { CliProviderManifest } from '@forgeax/types';
import type { Driver } from '@forgeax/agent-runtime';
import { getDriver } from '@forgeax/agent-runtime';
import type { MergedManifest } from '../merger';
import type { KindLoadIssue } from './types';
import type { PluginLayer } from '../scanner';

export interface CliProviderEntry {
  pluginId: string;
  layer: PluginLayer;
  /** ProvidesCliProvider.id — the Driver.id consumers use to look up. */
  providerId: string;
  displayName: string;
  manifest: CliProviderManifest;
  /** Resolved absolute path to entry.backend, or null when the plugin
   *  delegates to an in-tree driver (forgeax-native). */
  backendPath: string | null;
  /** Capabilities + models echoed verbatim from the manifest for UI. */
  models: string[];
  capabilities: NonNullable<CliProviderManifest['provides']['cliProvider']['capabilities']>;
}

/** Extract a CliProviderEntry from a MergedManifest. Returns
 *  `{entry: null}` when `m.kind !== 'cli-provider'`. */
export function loadCliProvider(
  merged: MergedManifest,
): { entry: CliProviderEntry | null; issues: KindLoadIssue[] } {
  const m = merged.manifest;
  if (m.kind !== 'cli-provider') return { entry: null, issues: [] };

  const cp = m.provides.cliProvider;
  const issues: KindLoadIssue[] = [];

  // Resolve the backend module path (relative to manifest dir). When the
  // manifest omits entry.backend we treat it as an in-tree driver — the
  // loader will look the providerId up in the agent-runtime driver
  // registry at first use.
  const backend = m.entry?.backend?.trim();
  const backendPath = backend ? resolve(dirname(merged.originPath), backend) : null;

  // displayName falls back: cliProvider.displayName > manifest.displayName.zh > id
  const dn =
    cp.displayName?.trim() ||
    (typeof m.displayName === 'string'
      ? m.displayName
      : m.displayName.zh || m.displayName.en) ||
    cp.id;

  return {
    entry: {
      pluginId: m.id,
      layer: merged.layer,
      providerId: cp.id,
      displayName: dn,
      manifest: m,
      backendPath,
      models: cp.models ?? [],
      capabilities: cp.capabilities ?? {},
    },
    issues,
  };
}

/**
 * Lazy Driver materialization. Called on first chat() against a registry
 * entry. Three resolution paths in order:
 *   1. Driver already registered with `providerId` → use it (forgeax-native
 *      and any other in-tree driver hits this path).
 *   2. `entry.backendPath` set → dynamic-import the module, expect a
 *      `default` export of type Driver (or a `driver` named export).
 *   3. Otherwise → return null + issue; caller surfaces as health=false.
 *
 * The function caches the resolved Driver on the entry via a WeakMap so
 * repeated calls don't re-import.
 */
const driverCache = new WeakMap<CliProviderEntry, Driver>();

export async function loadDriverForEntry(
  entry: CliProviderEntry,
): Promise<{ driver: Driver | null; reason?: string }> {
  const cached = driverCache.get(entry);
  if (cached) return { driver: cached };

  const existing = getDriver(entry.providerId);
  if (existing) {
    driverCache.set(entry, existing);
    return { driver: existing };
  }

  if (!entry.backendPath) {
    return {
      driver: null,
      reason: `cli-provider ${entry.providerId} has no entry.backend and no in-tree driver is registered`,
    };
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(entry.backendPath)) as Record<string, unknown>;
  } catch (e) {
    return {
      driver: null,
      reason: `failed to import ${entry.backendPath}: ${(e as Error).message}`,
    };
  }

  const driver = (mod.default ?? mod.driver) as Driver | undefined;
  if (!driver || typeof driver.chat !== 'function' || typeof driver.health !== 'function') {
    return {
      driver: null,
      reason: `${entry.backendPath} does not export a Driver (default or named 'driver')`,
    };
  }
  if (driver.id !== entry.providerId) {
    return {
      driver: null,
      reason: `driver.id "${driver.id}" does not match manifest cliProvider.id "${entry.providerId}"`,
    };
  }
  driverCache.set(entry, driver);
  return { driver };
}

/** Test helper — drop the import cache so a re-loaded entry re-resolves. */
export function _resetCliProviderDriverCacheForTests(): void {
  // WeakMap can't be cleared; replace the binding via a fresh map.
  // (Caller-side approach: each test uses a fresh CliProviderEntry instance,
  // which a fresh `loadCliProvider()` call already produces.)
}
