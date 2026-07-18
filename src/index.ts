// forgeax-cli — package entry (Stage0).
//
// Reusable orchestration layer public surface. The product shell can either:
//   (a) import the high-level seam from here:  `import { createForgeaxApp } from 'forgeax-cli'`
//   (b) import individual routers/boot helpers via subpaths:
//       `import { createCliRouter } from 'forgeax-cli/api/cli/chat'`  (enabled by
//       the `"./*": "./src/*.ts"` export map).
//
// 现状(2026-06):产品壳 packages/server/src/main.ts 走 (a) —— `createForgeaxApp(ctx)`
// 装配全部 /api/* 路由 + boot;(b) 子路径导出仍开放给需要单独拿某个 router/helper 的场景。

export * from './app';

// Boot / lifecycle helpers used by product shells.
export { initPathManager } from './fs/path-manager';
export { ensureUserDirDefaults } from './defaults/scaffold';
export { initSessionManager, getSessionManager } from './core/session-manager';
export { bootCliProviders } from './cli-providers';
export { reloadExtensions } from './extensions/registry';
export { loadBrand, createBrandRouter } from './brand';
export { getVersion } from '@forgeax/platform-io';
export { listAllCommands } from './commands/runner';

// WS + watcher primitives the shell wires into Bun.serve.
export { WsHub, createWsHandler, type WsClientData } from './ws';
export { FsWatcher, type AssetDiskChangedEvent, type FileChangeEvent, type FsWatcherEvent } from './api/lib/watcher';

// Path helpers.
export { defaultProjectRoot } from '@forgeax/platform-io';
export { friendlyPath } from '@forgeax/platform-io';
export { mp, interfaceDist } from '@forgeax/platform-io';
