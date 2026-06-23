/**
 * Phase B2 — workbench kind loader.
 *
 * Translates a kind=workbench manifest into a WorkbenchEntry that the
 * Sidebar/MainArea strip consumes via /api/bus/plugins. The loader is
 * pure: identical manifests produce identical entries.
 */
import type { MergedManifest } from '../merger';
import type { WorkbenchEntry } from './types';

export function loadWorkbench(merged: MergedManifest): WorkbenchEntry | null {
  const m = merged.manifest;
  if (m.kind !== 'workbench') return null;
  const wb = m.provides.workbench;
  return {
    pluginId: m.id,
    layer: merged.layer,
    workbenchId: wb.id,
    position: wb.position ?? 999,
    panelSize: wb.panelSize ?? 'md',
    hidden: wb.hidden ?? false,
    surface: wb.surface,
    hasStandalone: !!m.entry?.standalone,
  };
}
