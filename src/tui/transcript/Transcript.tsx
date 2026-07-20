/**
 * Transcript.tsx —— 提交生命周期的唯一 owner(梁②)。
 *
 * 持 flushedCount:
 *   - reduceTranscript(log[0..flushed]) → <Static>(committed,Ink 只渲染新增,
 *     承载海量历史,提交后不再重渲)。
 *   - reduceTranscript(log[flushed..]) → live 区(本轮进行中,实时重渲;工具卡
 *     才能从 running→✓/✗ 更新,不被 Static 冻结)。
 *   - turn 结束(!busy)推进 flushed = log.length。彻底解决 Static 冻结(梁② 病根)。
 *
 * **切分必须在 reduce 之前**(按 log 下标切),否则跨边界的 tool_call/tool_result
 * 会被切到两段而配不上对。reduce 各段内部各自配对;一个完整 turn 的 call+result
 * 同在 live 段,turn 结束后整段一起进 Static,配对关系完好。
 *
 * 单条渲染(P6 合龙已接真渲染器):
 *   - tool      → resolveToolByMeta(toolMeta, name):先经 driver.toolMeta(name).canonical
 *                 吃掉别名(`Bash`→`bash`),再按 canonical 真名查 views/tools/registry;
 *                 未命中落 Default(永不抛)。
 *   - assistant → views/messages:thinking(可折叠,expanded 控)+ text。
 *   - user / notice → views/messages 按 key 分发。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useMemo, useRef } from 'react';
import { Box, Static, Text } from 'ink';
import type { TranscriptItem, SessionEntry } from './items';
import { reduceTranscript, safeFlushBoundary } from './reduce';
import { clipStreamTail, streamTailBudget } from './stream-tail';
import { useTheme } from '../providers/theme';
import type { ThemeTokens } from '../contracts';
import { resolveToolByMeta } from '../views/tools/registry';
import { resolveMessageByItem, type MessageViewProps } from '../views/messages/registry';
import { ThinkingView, thinkingText } from '../views/messages/Thinking';
import { LiveThinking } from '../components/LiveThinking';
import { termWidth } from '../text-width';
import { shellMarksEnabled } from '../shell-marks';

/** driver.toolMeta 的最小形状(查工具卡只需 canonical;别名在此被吃掉)。 */
type ToolMetaFn = (name: string) => { canonical: string; displayName: string };

export interface TranscriptProps {
  /** session 真相:有序事件日志(梁②;user 输入 + 原生 AgentEvent)。 */
  log: SessionEntry[];
  /** 本轮是否进行中。!busy 时把 live 段提交进 Static(推进 flushed)。 */
  busy: boolean;
  /** driver.toolMeta:工具卡查表前经它解析 canonical(吃掉别名)。 */
  toolMeta: ToolMetaFn;
  /** ctrl+o 控制 thinking 是否展开(透传给 views/messages/Thinking)。 */
  expanded?: boolean;
  /** /resume 等整体替换 transcript 时由上层自增:并入 <Static key> 强制重挂载 → 从
   *  完整新会话重新 emit 全量历史(否则 Ink <Static> 只追加,旧 transcript 不会被替换)。 */
  redrawNonce?: number;
  /** 本轮正在流式写入、尚未被 `assistant` 事件收口的文本(节流后)。空串=无在写文本。
   *  渲染在 live 尾部,与最终 assistant 条目走同一渲染路径(视觉零跳变)。 */
  streamingText?: string;
  /** 本轮正在流式写入的 thinking(节流后,F2)。空串=无在写 thinking。渲染在流式文本**之上**
   *  (thinking 先于答案),dim 呈现;`assistant` 事件到达即清空 → 由 durable 条目的折叠
   *  ThinkingView 接管(「先显示 → 折叠」)。 */
  streamingThinking?: string;
  /** 欢迎横幅等一次性头部:prepend 到 <Static> items 最前,发射一次随 scrollback 上滚；
   *  仅 transcript 整体替换(redrawNonce)时重现，普通 resize 不重挂载 Static。
   *  渲染关切非会话数据 —— 不进 log,不参与 reduce。 */
  header?: React.ReactNode;
}

/** header 的 Static 哨兵条目。**刻意不进闭合 union `TranscriptItem`**，仅 Transcript 内部
 *  把 Static items 元素类型局部放宽为 `TranscriptItem | BannerItem`,render callback
 *  先按 kind==='banner' 分流。id=-2 哨兵(-1 已被流式合成条目占用,真实条目 ≥0)。 */
type BannerItem = { kind: 'banner'; id: -2; node: React.ReactNode };
type StaticEntry = TranscriptItem | BannerItem;

/** 把在写文本包成一条合成 assistant 条目,复用 renderItem → AssistantView → Markdown。
 *  id 用 -1 哨兵(绝不与真实 log 下标 ≥0 冲突)。 */
function streamingItem(text: string): TranscriptItem {
  return {
    kind: 'assistant',
    id: -1,
    event: {
      type: 'assistant',
      message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } },
    },
  } as TranscriptItem;
}

export function Transcript(props: TranscriptProps): React.ReactElement {
  const { log, busy, toolMeta, expanded, redrawNonce = 0, streamingText = '', streamingThinking = '', header } = props;
  const theme = useTheme();
  // shell-integration 标记(OSC 133)只挂 committed 的 user 条目(live 区每帧重画会重置终端
  //   command 记账 —— 绝不发)。enablement 两道闸走 shellMarksEnabled()(真 TTY + 未 env 关)。
  const shellMarks = shellMarksEnabled();

  // 只在 transcript 身份整体替换时重挂载 Static。resize 由终端 reflow 已提交历史、由
  // Ink 原地重画动态区；绝不能重挂载 Static，否则旧 scrollback 后会再追加一份历史。
  const staticRenderKey = redrawNonce;

  // ── 提交边界(增量):把「已定型」的前缀持续刷进 <Static>,而非憋到 turn 结束。
  //   旧实现把整轮输出全留在 live 动态区直到 !busy → 长输出时动态区超过终端高度,
  //   Ink 每帧整段擦除重画(还叠加 spinner / elapsed 高频刷),视口被反复拽回底部 →
  //   往上滚就被弹回、滚不到底。改为:
  //     ① 随日志推进到 safeFlushBoundary(所有已出现工具均已配对的最大前缀),单调不退;
  //        live 动态区只剩「仍在 running 的工具卡 + 其后尾巴」,恒压在一屏内。
  //     ② turn 结束(!busy)兜底全量提交(含被 abort 的 running 卡 —— 其 result 永不再来,
  //        已是 terminal,可安全冻结)。
  //     ③ 日志缩短(rewind/clear)时把 flushed 夹回,避免越界 / committed 与 live 重复。
  //   推进必须在**渲染期同步**算(ref 派生,不走 useState+useEffect):effect 在 paint 之后,
  //   刚落日志的长 assistant 条目会先在 live 动态区画一帧 —— 超视口时顶部行滚进
  //   scrollback 永远擦不掉,留下一整份残影拷贝(ttydrive-ghost-e2e 抓的就是它)。
  const flushedRef = useRef(0);
  const flushedNonceRef = useRef(redrawNonce);
  // 整体替换时已经存在的条目属于「历史重放」。它们要重新显示，但不能重新发 OSC 133：
  // VS Code 会把每条旧 user 当成刚执行的 command，最终在视口顶部留下空的 sticky command 横条。
  // cutoff 之后追加的新 user 仍正常发标记，保留 cmd+↑/↓ 与 sticky scroll 能力。
  const replayCutoffRef = useRef(0);
  if (flushedNonceRef.current !== redrawNonce) {
    // transcript 身份已整体替换:旧 session 的 log 下标不能作为新 session 的提交游标。
    flushedNonceRef.current = redrawNonce;
    flushedRef.current = 0;
    replayCutoffRef.current = log.length;
  }
  const boundary = useMemo(() => safeFlushBoundary(log), [log]);
  const flushed = Math.min(busy ? Math.max(flushedRef.current, boundary) : log.length, log.length);
  flushedRef.current = flushed;

  // 先按 log 下标切,再各自 reduce(保证跨边界的 call/result 不被切散)。
  const committed = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(0, flushed)),
    [log, flushed],
  );
  const live = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(flushed)),
    [log, flushed],
  );

  // header 只属于 transcript 的开头。普通 resize 不重挂载 Static，因此不会把 banner 或
  // 尾部历史重复追加到 scrollback；/clear、/resume、rewind 会先清旧 scrollback，再通过
  // redrawNonce 全量发射新的 transcript。
  const staticItems: StaticEntry[] =
    header != null ? [{ kind: 'banner', id: -2, node: header }, ...committed] : committed;
  const replayCutoff = replayCutoffRef.current;

  // ── 在写文本的尾部视口裁剪:整段流式文本渲染在动态区,一旦高过终端视口,Ink 每帧
  //   擦不掉溢出顶部的行 → scrollback 每帧积一份残影(resize 清屏才消)。按视觉行
  //   (CJK 感知折行)只保留末尾预算内的行,与 LiveThinking 的 MAX_LINES 同思路;
  //   收口后 durable 条目仍是全文,被裁的开头本来也早滚出视口。见 stream-tail.ts。
  const streamTail = useMemo(
    () =>
      clipStreamTail(streamingText, termWidth(), streamTailBudget(process.stdout.rows ?? 24)),
    [streamingText],
  );

  return (
    <Box flexDirection="column">
      {/* committed:Ink <Static> 只渲染新增条目；key 仅在 transcript 整体替换时变化。
          每块上方留一行(marginTop=1)给透气感。 */}
      <Static key={staticRenderKey} items={staticItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column" marginTop={1}>
            {item.kind === 'banner'
              ? item.node
              : renderItem(
                  item,
                  theme,
                  toolMeta,
                  expanded,
                  shellMarks && item.id >= replayCutoff,
                )}
          </Box>
        )}
      </Static>

      {/* live:本轮进行中条目(实时重渲;工具卡 running→✓/✗ 在此更新)。 */}
      {live.map((item) => (
        <Box key={item.id} flexDirection="column" marginTop={1}>
          {renderItem(item, theme, toolMeta, expanded)}
        </Box>
      ))}

      {/* 在写 thinking(流式,节流后,F2):渲染在流式文本**之上**(thinking 先于答案),dim;
          `assistant` 事件到达即清空 → 由 durable 条目的折叠 ThinkingView 接管(先显示→折叠)。 */}
      {streamingThinking ? (
        <Box key="streaming-thinking" flexDirection="column" marginTop={1}>
          <LiveThinking text={streamingThinking} />
        </Box>
      ) : null}

      {/* 在写文本(流式,节流后):live 尾部渲染合成 assistant 条目;`assistant` 事件到达即
          清空(streamingText 归 '') → 由上面 live 里的 durable 条目接管,视觉零跳变。
          超视口预算时只渲染末尾窗口(clipStreamTail),前部以 `…` 标记 —— 否则动态区
          高过终端,Ink 每帧擦不净溢出行,scrollback 积残影。 */}
      {streamingText ? (
        <Box key="streaming" flexDirection="column" marginTop={1}>
          {streamTail.clipped ? <Text color={theme.dim}>{'…'}</Text> : null}
          {renderItem(streamingItem(streamTail.text), theme, toolMeta, expanded)}
        </Box>
      ) : null}
    </Box>
  );
}

/** 单条渲染分发(无 switch on 渲染器;查表走 registry)。 */
function renderItem(
  item: TranscriptItem,
  theme: ThemeTokens,
  toolMeta: ToolMetaFn,
  expanded?: boolean,
  shellMarks?: boolean,
): React.ReactNode {
  if (item.kind === 'tool') {
    // 工具卡:经 toolMeta(name).canonical 解析(吃掉别名)→ views/tools/registry。
    const meta = toolMeta(item.name);
    const view = resolveToolByMeta(toolMeta, item.name);
    return view({
      name: meta.canonical,
      displayName: meta.displayName,
      input: item.input,
      result: item.result,
      status: item.status,
      isError: item.isError,
      theme,
    });
  }

  if (item.kind === 'assistant' && item.event.type === 'assistant') {
    // assistant:先渲染 thinking(若有,可折叠),再渲染 text(经 messages registry)。
    const hasThinking = thinkingText(item.event).length > 0;
    const props: MessageViewProps = { item, theme, expanded };
    const text = resolveMessageByItem(item);
    return (
      <>
        {hasThinking ? <Box key="thinking">{ThinkingView(props)}</Box> : null}
        <Box key="text">{text(props)}</Box>
      </>
    );
  }

  // user / notice / 其它 assistant → messages registry 按 key 分发。
  //   shellMarks 仅 UserView 消费(committed user 条目带 OSC 133;live 传 undefined→不带)。
  if (item.kind === 'user' || item.kind === 'notice' || item.kind === 'assistant') {
    const view = resolveMessageByItem(item);
    return view({ item, theme, expanded, shellMarks });
  }
  return null;
}
