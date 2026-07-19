/**
 * Question provider —— 桥接原生 askQuestion ↔ UI(useQuestionQueue)。
 *
 * 真实闭环:AskUserQuestion 工具(capability/builtin-tools/ask-tools.ts)经 ctx.askQuestion
 * 接缝把整组结构化问题转给 host → 本 provider 的 `ask` enqueue 一条 PendingQuestion,返回
 * Promise;UI 渲染提问浮层 → 用户逐题选择 → confirm 推进 → 末题组装 answers 并 resolve。
 *
 * 与 permission provider 对称(契约分、渲染合):askUser 是布尔闸,askQuestion 是结构化取数。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import type {
  AskQuestionFn,
  AskQuestionItem,
  AskQuestionAnswer,
  PendingQuestion,
  PromptState,
  QuestionQueue,
} from '../contracts';

const QuestionContext = createContext<QuestionQueue | null>(null);

const emptyBuf = (): PromptState => ({ value: '', cursor: 0 });

/** 选中的真选项 label + 非空自填文本 → 与 questions 同序的 answers。
 *  自填文本既进 selected(供模型直接读),也单独落 other(observability)。 */
function buildAnswers(
  items: AskQuestionItem[],
  selections: number[][],
  others: PromptState[],
): AskQuestionAnswer[] {
  return items.map((it, i) => {
    const idxs = selections[i] ?? [];
    const selected = idxs
      .map((oi) => it.options[oi]?.label)
      .filter((l): l is string => typeof l === 'string');
    const otherText = (others[i]?.value ?? '').trim();
    if (otherText) return { selected: [...selected, otherText], other: otherText };
    return { selected };
  });
}

export function QuestionProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [pending, setPending] = useState<PendingQuestion[]>([]);
  const idSeq = useRef(0);
  // resolve 映射:id → resolver(避免 stale closure;在 setState 之外调用)。
  const resolvers = useRef(new Map<string, (answers: AskQuestionAnswer[]) => void>());
  // pending 的同步镜像:confirm/cancel 在事件回调里读最新已提交态,resolver 调用不进 setState updater。
  const pendingRef = useRef<PendingQuestion[]>([]);
  pendingRef.current = pending;

  const ask = useCallback<AskQuestionFn>((questions: AskQuestionItem[]) => {
    const id = `q-${++idSeq.current}`;
    return new Promise<AskQuestionAnswer[]>((resolve) => {
      resolvers.current.set(id, resolve);
      const entry: PendingQuestion = {
        id,
        items: questions,
        cursor: 0,
        selections: questions.map(() => []),
        others: questions.map(() => emptyBuf()),
      };
      setPending((prev) => [...prev, entry]);
    });
  }, []);

  /** resolve + 出队(永不在 setState updater 内调 resolver)。 */
  const finish = useCallback((id: string, answers: AskQuestionAnswer[]) => {
    const r = resolvers.current.get(id);
    resolvers.current.delete(id);
    setPending((prev) => prev.filter((p) => p.id !== id));
    if (r) r(answers);
  }, []);

  const toggle = useCallback((id: string, optionIndex: number) => {
    setPending((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const item = p.items[p.cursor];
        if (!item?.multiSelect) return p; // 单选题:空格 no-op
        if (optionIndex >= item.options.length) return p; // 自填项不参与勾选
        const cur = p.selections[p.cursor] ?? [];
        const next = cur.includes(optionIndex)
          ? cur.filter((i) => i !== optionIndex)
          : [...cur, optionIndex];
        return { ...p, selections: p.selections.map((s, i) => (i === p.cursor ? next : s)) };
      }),
    );
  }, []);

  const editOther = useCallback((id: string, next: PromptState) => {
    setPending((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, others: p.others.map((o, i) => (i === p.cursor ? next : o)) }
          : p,
      ),
    );
  }, []);

  const confirm = useCallback(
    (id: string, highlightIndex: number) => {
      const p = pendingRef.current.find((x) => x.id === id);
      if (!p) return;
      const item = p.items[p.cursor];
      const otherIndex = item ? item.options.length : -1; // 自填项 = 真选项之后那一行
      let selections = p.selections;
      let others = p.others;
      if (!item?.multiSelect) {
        // 单选:高亮真选项 → [idx] 并清掉本题自填;高亮自填项 → 空真选(自填文本走 others)。
        const sel = highlightIndex === otherIndex ? [] : [highlightIndex];
        selections = p.selections.map((s, i) => (i === p.cursor ? sel : s));
        if (highlightIndex !== otherIndex) {
          others = p.others.map((o, i) => (i === p.cursor ? emptyBuf() : o));
        }
      }
      // 多选:selections/others 已即时反映用户勾选/打字,确认时原样提交。
      const nextCursor = p.cursor + 1;
      if (nextCursor < p.items.length) {
        setPending((prev) =>
          prev.map((x) => (x.id === id ? { ...x, cursor: nextCursor, selections, others } : x)),
        );
        return;
      }
      finish(id, buildAnswers(p.items, selections, others));
    },
    [finish],
  );

  const cancel = useCallback(
    (id: string) => {
      const p = pendingRef.current.find((x) => x.id === id);
      // 跳过 = 每题空选(对齐 cc「declined to answer」;工具据空 selected 知道用户未选)。
      finish(id, p ? p.items.map(() => ({ selected: [] })) : []);
    },
    [finish],
  );

  /** 一次性回答当前题(远端中转用):原子写选择 + 推进/收尾。
   *  与 confirm(键盘路径:toggle/editOther 先行、confirm 只收口)不同,远端回复一条消息
   *  就带全部选择,须在同一次调用里落 selections/others 并推进,避免跨 setState 竞态。 */
  const answer = useCallback(
    (id: string, a: { options?: number[]; other?: string }) => {
      const p = pendingRef.current.find((x) => x.id === id);
      if (!p) return;
      const item = p.items[p.cursor];
      if (!item) return;
      // 序号越界的丢弃;单选题只取首个合法项。
      let idxs = (a.options ?? []).filter((i) => i >= 0 && i < item.options.length);
      if (!item.multiSelect) idxs = idxs.slice(0, 1);
      const otherText = (a.other ?? '').trim();
      const selections = p.selections.map((s, i) => (i === p.cursor ? idxs : s));
      const others = p.others.map((o, i) =>
        i === p.cursor ? { value: otherText, cursor: otherText.length } : o,
      );
      const nextCursor = p.cursor + 1;
      if (nextCursor < p.items.length) {
        setPending((prev) =>
          prev.map((x) => (x.id === id ? { ...x, cursor: nextCursor, selections, others } : x)),
        );
        return;
      }
      finish(id, buildAnswers(p.items, selections, others));
    },
    [finish],
  );

  const value = useMemo<QuestionQueue>(
    () => ({ pending, ask, toggle, editOther, confirm, cancel, answer }),
    [pending, ask, toggle, editOther, confirm, cancel, answer],
  );
  return <QuestionContext.Provider value={value}>{props.children}</QuestionContext.Provider>;
}

export function useQuestionQueue(): QuestionQueue {
  const v = useContext(QuestionContext);
  if (!v) throw new Error('useQuestionQueue must be used within <QuestionProvider>');
  return v;
}
