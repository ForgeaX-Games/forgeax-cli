/** @desc Shared helpers for overlay-flow item construction and confirmations. */

import type { ProvisioningPhase } from "../../../../core/types.js";
import { PROVISIONING_PHASE_LABEL } from "../../../../core/types.js";
import { C } from "../../lib/colors.js";
import { theme } from "../../lib/theme.js";
import type { RendererDataSource, SelectItem, OverlayLayout } from "../../types.js";
import type { OverlaySchedulerResult } from "../use-overlay-scheduler.js";

type InstanceLike = { id: string; status: string; statusMessage?: string; provisioningPhase?: string };

export function formatInstanceHint(i: InstanceLike): string {
  if (i.status === "provisioning" && i.provisioningPhase) {
    const label = PROVISIONING_PHASE_LABEL[i.provisioningPhase as ProvisioningPhase];
    if (label) return `[provisioning] ${label}`;
  }
  return `[${i.status}]${i.statusMessage ? ` ${i.statusMessage}` : ""}`;
}

export function instanceHintColor(status: string): string {
  return theme.instanceStatus[status as keyof typeof theme.instanceStatus] ?? C.blackBright;
}

/** Map an instance list into SelectItems with consistent hint + hintColor. */
export function buildInstanceItems(
  instances: InstanceLike[],
  opts?: {
    disabled?: (i: InstanceLike) => boolean;
    mapItem?: (i: InstanceLike, item: SelectItem) => SelectItem;
  },
): SelectItem[] {
  return instances.map(i => {
    const item: SelectItem = {
      label: i.id,
      hint: formatInstanceHint(i),
      hintColor: instanceHintColor(i.status),
      disabled: opts?.disabled?.(i),
    };
    return opts?.mapItem ? opts.mapItem(i, item) : item;
  });
}

export function makeInstanceLoadItems(
  dataSource: RendererDataSource,
  opts?: Parameters<typeof buildInstanceItems>[1],
): () => Promise<SelectItem[]> {
  return async () => buildInstanceItems(await dataSource.listInstances!(), opts);
}

export function pushConfirm(
  scheduler: OverlaySchedulerResult,
  opts: {
    id: string;
    title: string;
    confirmLabel: string;
    confirmHint?: string;
    cancelLabel?: string;
    layout?: OverlayLayout;
    onConfirm: () => void;
  },
): void {
  scheduler.push({
    id: opts.id,
    kind: "select",
    layout: opts.layout ?? "fullscreen",
    title: opts.title,
    items: [
      { label: opts.confirmLabel, hint: opts.confirmHint },
      { label: opts.cancelLabel ?? "取消" },
    ],
    onConfirm: (idx) => {
      if (idx !== 0) return;
      opts.onConfirm();
    },
  });
}
