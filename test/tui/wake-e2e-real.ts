/**
 * T4.5 · idle 自动唤醒真实 e2e —— 真 PTY 里驱动真实 Ink TUI + 真 Anthropic API。
 *
 * 验收口径(todo 011):TUI 挂后台 `sleep N && echo <marker>`,用户不再输入 →
 * N 秒后 agent **自动跑一轮**并播报结果。对照 T4:通知只会躺到下一次用户说话。
 *
 * 证据两路:
 *  ① 屏幕:唤醒 notice(「后台任务完成」)+ 唤醒轮的 assistant 回复渲染在屏;
 *  ② WAL(请求体证据):sessions/<sid>/events.jsonl 里出现一条 user_prompt.submit,
 *     其 prompt 含 `<task_notification>` 与后台命令 —— WAL 的 user 轮就是喂给
 *     provider 的那条消息,等价于「代理抓包证请求体含通知」。
 *
 * 不是 .test.ts(真 API + 网络 + ~2min 时长),手动跑:
 *   set -a; source <repo>/.env; set +a
 *   bun test/tui/wake-e2e-real.ts
 * 退出码 = 失败数。前置:python3(ttydrive.py)、ANTHROPIC_API_KEY。
 * 证据留档:设 FORGEAX_WAKE_E2E_EVIDENCE=<dir> → 终屏快照(screen.txt)、会话 WAL
 * (events.jsonl)、时间线摘要(timeline.txt)拷进该目录(验收存档用)。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir; // …/packages/cli/test/tui
const CORE_ROOT = join(HERE, '..', '..');
const MAIN = join(CORE_ROOT, 'src', 'cli', 'main.ts');
const TTYDRIVE = join(HERE, 'ttydrive.py');

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('需要 ANTHROPIC_API_KEY(先 `set -a; source .env; set +a`)。');
  process.exit(2);
}
const python = Bun.which('python3');
if (!python) {
  console.error('需要 python3(ttydrive.py 驱动 PTY)。');
  process.exit(2);
}

const MODEL = process.env.FORGEAX_MODEL ?? 'claude-opus-4-8';
const MARKER = 'WAKE_E2E_MARKER_OK';

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'wake-e2e-'));
  const sessionsDir = join(dir, 'sessions');
  try {
    // 声明式放行 bash(工程验收环境,非交互跑;两种拼写都给,规则按 canonical 归一)。
    mkdirSync(join(dir, '.forgeax'), { recursive: true });
    writeFileSync(join(dir, '.forgeax', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'bash'] } }));

    const prompt =
      `Use the bash tool with run_in_background=true to run exactly: sleep 8 && echo ${MARKER} . ` +
      `After it starts, reply with just the word started and end your turn immediately. ` +
      `Do not poll bash_output, do not wait for it.`;

    const spec = {
      cmd: ['bun', MAIN, '--no-memory'],
      env: {
        ANTHROPIC_API_KEY: KEY,
        ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
        FORGEAX_MODEL: MODEL,
        FORGEAX_NO_TUI: '',
        FORGEAX_SKIP_TRUST: '1',
        FORGEAX_SESSIONS_DIR: sessionsDir,
      },
      boot_ms: 4000,
      // 提交后完全不再输入:模型起后台任务(真 API 一轮)→ 8s 后 sleep 完成 →
      // T4.5 idle 唤醒自动再跑一轮(真 API)→ 播报。预算放宽到 90s 容忍模型/网络慢。
      steps: [
        { send: prompt, then_ms: 1200 },
        { send: '<CR>', then_ms: 90000 },
      ],
      settle_ms: 3000,
    };
    const stepFile = join(dir, 'step.json');
    writeFileSync(stepFile, JSON.stringify(spec));

    console.log(`[wake-e2e] model=${MODEL} dir=${dir}`);
    console.log('[wake-e2e] 驱动真实 TUI:提交后台 sleep 8 任务后保持沉默 ~90s,等自动唤醒…');
    const proc = Bun.spawn([python!, TTYDRIVE, '40', '120', stepFile], {
      cwd: dir, // 隔离 cwd:后台 bash / .forgeax 全落 tmp
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    const m = out.match(/==== SCREEN[^\n]*\n([\s\S]*?)\n==== END ====/);
    const screen = m ? m[1] : out;

    const failures: string[] = [];
    const check = (name: string, ok: boolean, detail?: string): void => {
      console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
      if (!ok) failures.push(name);
    };

    // ① 屏幕证据。
    check('turn1: 模型已回复并结束(started)', /started/i.test(screen), 'screen 无 started');
    check('完成 notice 渲染在屏(带命令与退出态)', screen.includes('后台任务') && screen.includes('exit code 0'));
    check('唤醒轮标注渲染在屏(「自动续接」)', screen.includes('自动续接'));
    const noticeIdx = screen.indexOf('后台任务');
    const afterNotice = noticeIdx >= 0 ? screen.slice(noticeIdx) : '';
    check(
      '唤醒轮的 assistant 播报跟在 notice 之后(提到后台结果)',
      noticeIdx >= 0 && new RegExp(`${MARKER}|sleep 8|后台|background|completed|完成`, 'i').test(afterNotice.slice(20)),
      'notice 之后无播报内容',
    );

    // ② WAL 证据:唤醒轮以 user_prompt.submit 入轮,prompt 含 <task_notification>(它就是发给
    //   provider 的 user 消息 —— 请求体含通知的落盘等价证明)。
    let walProof = false;
    let walWake = '';
    let walFile = '';
    const timeline: string[] = [];
    if (existsSync(sessionsDir)) {
      for (const sid of readdirSync(sessionsDir)) {
        const f = join(sessionsDir, sid, 'events.jsonl');
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          // 时间线:所有 user_prompt.submit + turn 终局(证明「唤醒轮在用户零输入下自发」)。
          try {
            const ev = JSON.parse(line) as { type?: string; ts?: number; payload?: { prompt?: string } };
            if (ev.type === 'user_prompt.submit') {
              const p = ev.payload?.prompt ?? '';
              const kind = p.includes('<task_notification>') ? 'WAKE(auto)' : 'USER(typed)';
              timeline.push(`${new Date(ev.ts ?? 0).toISOString()}  user_prompt.submit  ${kind}  ${p.slice(0, 80).replace(/\n/g, '\\n')}…`);
            } else if (ev.type?.startsWith('turn')) {
              timeline.push(`${new Date((ev as { ts?: number }).ts ?? 0).toISOString()}  ${ev.type}`);
            }
          } catch {
            /* 非 JSON 行忽略 */
          }
          if (line.includes('<task_notification>') && line.includes('user_prompt')) {
            walProof = true;
            walWake = line.slice(0, 300);
            walFile = f;
          }
        }
      }
    }
    check('WAL:唤醒轮 user_prompt 含 <task_notification>(请求体证据)', walProof);
    if (walWake) console.log(`[wake-e2e] WAL 唤醒轮片段: ${walWake}…`);
    if (timeline.length) {
      console.log('\n[wake-e2e] WAL 时间线(user_prompt.submit / turn 终局):');
      for (const t of timeline) console.log('  ' + t);
    }

    // 证据留档:终屏 + WAL + 时间线拷进指定目录(验收存档)。
    const evidenceDir = process.env.FORGEAX_WAKE_E2E_EVIDENCE;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'screen.txt'), screen);
      writeFileSync(join(evidenceDir, 'timeline.txt'), timeline.join('\n') + '\n');
      if (walFile) copyFileSync(walFile, join(evidenceDir, 'events.jsonl'));
      console.log(`[wake-e2e] 证据已留档: ${evidenceDir}(screen.txt / timeline.txt / events.jsonl)`);
    }

    if (failures.length) {
      console.log('\n==== SCREEN(失败现场)====\n' + screen + '\n==== END ====');
    }
    console.log(`\n[wake-e2e] ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`);
    return failures.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(await main());
