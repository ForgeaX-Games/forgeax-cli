/**
 * @desc Operational overlay flows — pack clean-image, rm-containers, sync-pack.
 */

import type { OverlayFlowDeps } from "./types.js";
import { C } from "../../lib/colors.js";
import { makeInstanceLoadItems, pushConfirm } from "./helpers.js";

// ── Pack clean-image (select pack → confirm) ──

export function showPackCleanImage({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  if (!dataSource.listPacks) return;
  scheduler.push({
    id: "pack-clean-image-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要清理镜像的 Pack",
    loadItems: async () => {
      const packs = await dataSource.listPacks!();
      return packs.map(p => ({
        label: p.id,
        hint: `${p.version ? `v${p.version}` : ""} ${p.isBuilt ? "[已构建]" : "[未构建]"}`.trim(),
        hintColor: p.isBuilt ? C.green : C.blackBright,
      }));
    },
    onConfirm: (_idx, item) => {
      const packId = item.label;
      pushConfirm(scheduler, {
        id: "pack-clean-image-confirm",
        title: `确认删除 Pack "${packId}" 的镜像？`,
        confirmLabel: "确认删除镜像（可重新构建）",
        onConfirm: () => {
          if (!dataSource.packCleanImage) return;
          scheduler.clear();
          dataSource.packCleanImage(packId)
            .then(r => pushSystemMessage(
              `🗑  Pack "${packId}" 镜像已清理` +
              `\n  Docker 镜像: ${r.imageRemoved ? "已删除" : "未找到"}` +
              `\n  image.tar: ${r.tarRemoved ? "已删除" : "未找到"}`,
            ))
            .catch(e => pushSystemMessage(`❌ 清理失败: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    },
  });
}

// ── Remove all containers (select instance → confirm) ──

export function showRemoveContainers(deps: OverlayFlowDeps): void {
  const { scheduler, dataSource, pushSystemMessage } = deps;
  if (!dataSource.listInstances) return;
  scheduler.push({
    id: "rm-containers-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要删除容器的 Instance",
    loadItems: makeInstanceLoadItems(dataSource),
    onConfirm: (_idx, item) => {
      const targetId = item.label;
      pushConfirm(scheduler, {
        id: "rm-containers-confirm",
        title: `确认删除 Instance "${targetId}" 的全部容器？`,
        confirmLabel: "确认删除全部容器",
        onConfirm: () => {
          if (!dataSource.removeContainers) return;
          scheduler.clear();
          dataSource.removeContainers(targetId)
            .then(r => {
              const msg = r.removed.length > 0
                ? `🗑  已删除 ${r.removed.length} 个容器: ${r.removed.join(", ")}`
                : `ℹ  Instance "${targetId}" 无容器需要清理`;
              pushSystemMessage(msg);
            })
            .catch(e => pushSystemMessage(`❌ 删除容器失败: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    },
  });
}

// ── Sync team → pack (choose bump type → execute) ──

function bumpVersion(cur: string, type: "major" | "minor" | "patch"): string {
  const p = cur.split(".").map(Number);
  while (p.length < 3) p.push(0);
  switch (type) {
    case "major": return `${p[0]! + 1}.0.0`;
    case "minor": return `${p[0]}.${p[1]! + 1}.0`;
    case "patch": return `${p[0]}.${p[1]}.${p[2]! + 1}`;
  }
}

export function showSyncPack({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  if (!dataSource.teamSyncPreview) return;

  scheduler.push({
    id: "sync-pack-preview",
    kind: "select",
    layout: "fullscreen",
    title: "同步 Team → Pack（加载预览中...）",
    loadItems: async () => {
      const preview = await dataSource.teamSyncPreview!();
      const v = preview.currentVersion;
      const fileHint = preview.files.length > 0
        ? `${preview.files.length} 个文件变更`
        : "无文件变更";
      return [
        { label: `patch  ${v} → ${bumpVersion(v, "patch")}`, hint: `${preview.packId} · ${fileHint}` },
        { label: `minor  ${v} → ${bumpVersion(v, "minor")}`, hint: `${preview.packId} · ${fileHint}` },
        { label: `major  ${v} → ${bumpVersion(v, "major")}`, hint: `${preview.packId} · ${fileHint}` },
        { label: "取消" },
      ];
    },
    onConfirm: (idx) => {
      const bumpTypes = ["patch", "minor", "major"] as const;
      if (idx >= bumpTypes.length) return;
      const bumpType = bumpTypes[idx]!;
      if (!dataSource.teamSyncPreview || !dataSource.teamSyncExecute) return;
      scheduler.clear();
      (async () => {
        try {
          const preview = await dataSource.teamSyncPreview!();
          const newVersion = bumpVersion(preview.currentVersion, bumpType);
          await dataSource.teamSyncExecute!(newVersion);
          const summary = preview.files.length > 0
            ? preview.files.map(f => `  ${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path}`).join("\n")
            : "  (无文件变更)";
          pushSystemMessage(
            `✅ 已同步到 Pack "${preview.packId}" v${newVersion}` +
            `\n${summary}`,
          );
        } catch (e) {
          pushSystemMessage(`❌ 同步失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
  });
}
