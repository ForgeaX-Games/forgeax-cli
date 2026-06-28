/** 信任闸单测(T-D 三档 allow/ask/deny)。
 *  own:读/写/编辑/委派直放;危险 {exec,network,credential,delete} → ask。
 *  imported:读/委派直放;credential 硬 deny;exec/network → ask;write/delete 游戏内 ask、外 deny。 */
import { describe, expect, test } from 'bun:test';
import { checkKernelTool, classifyTool } from '../src/kernel/trust-gate';

describe('classifyTool', () => {
  test('按子串分类(顺序敏感)', () => {
    expect(classifyTool('get_secret')).toBe('credential'); // credential 先于 read
    expect(classifyTool('get_api_key')).toBe('credential');
    expect(classifyTool('Bash')).toBe('exec');
    expect(classifyTool('run_command')).toBe('exec');
    expect(classifyTool('http_get')).toBe('network'); // network 先于 read
    expect(classifyTool('fetch_url')).toBe('network');
    expect(classifyTool('delegate_to_subagent')).toBe('delegate');
    expect(classifyTool('delete_file')).toBe('delete'); // delete 先于 write
    expect(classifyTool('remove_dir')).toBe('delete');
    expect(classifyTool('write_file')).toBe('write');
    expect(classifyTool('edit_file')).toBe('write');
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('list_games')).toBe('read');
    expect(classifyTool('get_active_game')).toBe('read');
    expect(classifyTool('zzz_unknown')).toBe('other');
  });
});

describe('checkKernelTool — own (确认危险,直放读写编辑委派)', () => {
  test('读/写/编辑/委派 → allow', () => {
    expect(checkKernelTool('own', 'read_file').outcome).toBe('allow');
    expect(checkKernelTool('own', 'write_file').outcome).toBe('allow'); // 写代码是 Forge 主循环,不打断
    expect(checkKernelTool('own', 'edit_file').outcome).toBe('allow');
    expect(checkKernelTool('own', 'write_file', { args: { path: '/etc/passwd' } }).outcome).toBe('allow');
  });

  test('exec/network 直放(own 主循环 shell/curl 不打断)', () => {
    expect(checkKernelTool('own', 'Bash').outcome).toBe('allow');
    expect(checkKernelTool('own', 'http_get').outcome).toBe('allow');
    expect(checkKernelTool('own', 'shell').outcome).toBe('allow');
  });

  test('只有真正危险 {credential,delete} → ask', () => {
    expect(checkKernelTool('own', 'get_secret').outcome).toBe('ask');
    expect(checkKernelTool('own', 'delete_file').outcome).toBe('ask');
  });

  test('ask/deny 的 allow 字段为 false(向后兼容 fail-closed)', () => {
    const d = checkKernelTool('own', 'get_secret');
    expect(d.outcome).toBe('ask');
    expect(d.allow).toBe(false); // 旧调用方只看 .allow → 不会误放行
    expect(d.capability).toBe('credential');
  });
});

describe('checkKernelTool — imported (凭据硬拒,危险 ask,写删作用域)', () => {
  test('读/委派 → allow', () => {
    expect(checkKernelTool('imported', 'read_file').outcome).toBe('allow');
    expect(checkKernelTool('imported', 'list_games').outcome).toBe('allow');
    expect(checkKernelTool('imported', 'delegate_to_subagent').outcome).toBe('allow');
  });

  test('credential → deny(硬拒,绝不给不可信 pack 真凭据)', () => {
    expect(checkKernelTool('imported', 'get_secret').outcome).toBe('deny');
    expect(checkKernelTool('imported', 'get_api_key').outcome).toBe('deny');
  });

  test('exec/network → ask', () => {
    expect(checkKernelTool('imported', 'Bash').outcome).toBe('ask');
    expect(checkKernelTool('imported', 'run_command').outcome).toBe('ask');
    expect(checkKernelTool('imported', 'fetch_url').outcome).toBe('ask');
    expect(checkKernelTool('imported', 'http_get').outcome).toBe('ask');
  });

  test('write/delete 无路径上下文 → deny(fail-closed)', () => {
    expect(checkKernelTool('imported', 'write_file').outcome).toBe('deny');
    expect(checkKernelTool('imported', 'delete_file').outcome).toBe('deny');
  });

  test('未命中能力分类的工具(other)→ ask(交人判断,非静默放行,R2-09)', () => {
    // 注:"frobnicate" 含子串 "cat" → classifyTool 归 read(非 other),不是合格探针;
    // 用 "zorp"/"zzz_unknown" 这类真正命不中任何能力子串的名字。
    // imported 上叫不出名字的工具**不静默放行**:弹卡交用户判断(§8/§9),而非 deny 死路。
    const d = checkKernelTool('imported', 'zorp');
    expect(d.outcome).toBe('ask');
    expect(d.outcome).not.toBe('allow');
    expect(d.allow).toBe(false); // ask 仍 allow:false → 旧只看 .allow 的调用方不会误自动放行
    expect(checkKernelTool('imported', 'zzz_unknown').outcome).toBe('ask');
  });
});

describe('缺 trustTier → fail-closed(当 imported)', () => {
  test('危险/写 → 非 allow;读 → allow', () => {
    expect(checkKernelTool(undefined, 'Bash').outcome).toBe('ask'); // imported exec
    expect(checkKernelTool(undefined, 'get_secret').outcome).toBe('deny'); // imported credential
    expect(checkKernelTool(undefined, 'read_file').outcome).toBe('allow');
    expect(checkKernelTool(undefined, 'write_file').outcome).toBe('deny'); // imported write 无路径
  });

  test('未知工具(other)缺 trustTier → ask(回退 imported,交人判断 R2-09)', () => {
    const d = checkKernelTool(undefined, 'zorp');
    expect(d.outcome).toBe('ask');
    expect(d.allow).toBe(false); // 非自动放行
  });
});

describe('own 不回归(other 仍直放,读写执行不被收窄)', () => {
  test('own 的 other(zorp)仍 → allow', () => {
    const d = checkKernelTool('own', 'zorp');
    expect(d.outcome).toBe('allow');
    expect(d.allow).toBe(true);
  });

  test('own 读/写/执行仍直放', () => {
    expect(checkKernelTool('own', 'read_file').outcome).toBe('allow');
    expect(checkKernelTool('own', 'write_file').outcome).toBe('allow');
    expect(checkKernelTool('own', 'Bash').outcome).toBe('allow');
  });

  test('own 凭据/删除仍 → ask', () => {
    expect(checkKernelTool('own', 'get_secret').outcome).toBe('ask');
    expect(checkKernelTool('own', 'delete_file').outcome).toBe('ask');
  });
});

describe('R2-08 imported write/delete-scope(目录内 ask / 目录外 deny)', () => {
  const projectRoot = '/tmp/forgeax-ws';
  const activeGame = 'snake';

  test('写在激活游戏目录内 → ask(确认)', () => {
    const d = checkKernelTool('imported', 'write_file', {
      args: { path: '.forgeax/games/snake/src/main.ts' },
      projectRoot,
      activeGame,
    });
    expect(d.outcome).toBe('ask');
  });

  test('删在激活游戏目录内 → ask(确认)', () => {
    const d = checkKernelTool('imported', 'delete_file', {
      args: { path: '.forgeax/games/snake/src/old.ts' },
      projectRoot,
      activeGame,
    });
    expect(d.outcome).toBe('ask');
  });

  test('写到 games/** 之外 → deny', () => {
    const d = checkKernelTool('imported', 'write_file', {
      args: { path: 'src/secret.ts' },
      projectRoot,
      activeGame,
    });
    expect(d.outcome).toBe('deny');
  });

  test('写到另一个(非激活)游戏目录 → deny', () => {
    const d = checkKernelTool('imported', 'write_file', {
      args: { path: '.forgeax/games/other/src/main.ts' },
      projectRoot,
      activeGame,
    });
    expect(d.outcome).toBe('deny');
  });

  test('路径穿越越界(games-evil)→ deny', () => {
    const d = checkKernelTool('imported', 'write_file', {
      args: { path: '.forgeax/games/snake/../snake-evil/x.ts' },
      projectRoot,
      activeGame,
    });
    expect(d.outcome).toBe('deny');
  });

  test('无 activeGame → 限定到 games 根下任一游戏(ask)', () => {
    const d = checkKernelTool('imported', 'write_file', {
      args: { path: '.forgeax/games/anything/x.ts' },
      projectRoot,
    });
    expect(d.outcome).toBe('ask');
  });

  test('缺 projectRoot 或缺路径 → fail-closed(deny)', () => {
    expect(checkKernelTool('imported', 'write_file', { args: { path: '.forgeax/games/snake/x.ts' } }).outcome).toBe('deny');
    expect(checkKernelTool('imported', 'write_file', { projectRoot, activeGame }).outcome).toBe('deny');
  });
});

describe('委派/编排原语始终放行(含 imported)', () => {
  test('delegate/list 原语 → allow', () => {
    expect(checkKernelTool('imported', 'delegate_to_subagent').outcome).toBe('allow');
    expect(checkKernelTool('imported', 'list_subagents').outcome).toBe('allow');
    expect(checkKernelTool('imported', 'list_agents').outcome).toBe('allow');
    expect(checkKernelTool(undefined, 'delegate_to_subagent').outcome).toBe('allow');
  });
});
