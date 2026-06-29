/**
 * forgeax-cli 编排层依赖铁律(dependency-cruiser)。
 *
 * 心智:`forgeax-cli` 是「可独立拆出的编排层」。依赖倒置后它**只**允许依赖
 *   - `@forgeax/agent-runtime`(运行时契约)
 *   - `@forgeax/types`(zod schema SSOT)
 *   - package.json 里声明的第三方依赖(hono / zod / yaml / sharp / chokidar /
 *     minimatch / @google/genai / @ag-ui/core 等)+ node 内置。
 *
 * **禁止**反向依赖任何业务/内核宿主包,否则它就拆不出去了:
 *   - `@forgeax/forgeax-core`、`@forgeax/server`、`@forgeax/interface`、
 *     `@forgeax/studio`(以及经相对路径 `../../{server,interface,...}` 偷摸引用);
 *   - 任何内核适配 / CC SDK(`@anthropic-ai/*`、`*claude-code-sdk*`)——内核细节
 *     由宿主经 `createForgeaxApp` 注入,编排层不直接 bind 具体 driver。
 *
 * 与 packages/editor/.dependency-cruiser.cjs 同源写法;工具同为 dependency-cruiser。
 * 跑法:`bun run lint:boundaries`(见 package.json scripts)。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'cli-no-host-packages',
      severity: 'error',
      comment:
        '编排层不得依赖业务/内核宿主包(forgeax-core/server/interface/studio),' +
        '否则无法独立拆出;宿主由 createForgeaxApp 注入。',
      from: { path: '^src/' },
      to: {
        path: '@forgeax/(forgeax-core|server|interface|studio)(/|$)',
      },
    },
    {
      name: 'cli-no-host-relative',
      severity: 'error',
      comment:
        '禁止用相对路径绕过包名直接 reach into 兄弟宿主包源码' +
        '(../../server、../../interface、../../studio、../../forgeax-core)。',
      from: { path: '^src/' },
      to: {
        path: '(^|/)\\.\\./\\.\\./(server|interface|studio|forgeax-core)/',
      },
    },
    {
      name: 'cli-no-kernel-sdk',
      severity: 'error',
      comment:
        '编排层不直接绑定具体内核适配 / CC SDK(@anthropic-ai/*、claude-code-sdk);' +
        '内核细节由宿主注入。',
      from: { path: '^src/' },
      to: {
        path: '(@anthropic-ai/|claude-code-sdk)',
      },
    },
    {
      name: 'cli-allowed-forgeax-only',
      severity: 'error',
      comment:
        '@forgeax/* 范围内只允许 agent-runtime(契约)、types(schema)与 ' +
        'platform-io(后L1 文件/IO 基建,R1 抽出,cli 后L2→后L1 合法下行);' +
        '其余 @forgeax 包一律禁止。注意:@forgeax/engine-*、@forgeax/game-types ' +
        '若仅出现在 prompt 模板字符串里(非真实 import)不会被算作依赖。',
      from: { path: '^src/' },
      to: {
        path: '^@forgeax/',
        pathNot: '^@forgeax/(agent-runtime|types|platform-io)(/|$)',
      },
    },
    {
      // 编排层内部禁循环依赖(阻断级)。历史遗留的两处 cycle 已清:
      //   - skills↔plugins↔tools:plugins/registry 不再 import event-bridge,
      //     改由组合根(app boot)经 onPluginsReloaded 钩子接线(registry 成 sink)。
      //   - core↔kernel session 链:单例访问器下沉 session-registry.ts(对类仅
      //     import type,不计边),compose-turn-request 经 registry 取单例。
      // 注:image-gateway 内部 cycle 属在途 image-gen 重构(去 character 耦合),
      // 由该重构自行收口。
      name: 'no-circular',
      severity: 'error',
      comment: '编排层内部禁止循环依赖(运行时环)。',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', 'build', '.vite'],
    },
    // 只审 cli 自己的源码。
    includeOnly: '^src/',
    tsPreCompilationDeps: false,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
