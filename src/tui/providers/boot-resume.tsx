/**
 * BootResume —— 启动时一次性的「续接会话 id」信号(T1)。
 *
 * `runTui` 判定启动带 `--resume <id>` / `--continue` 且该会话**已有 WAL 历史**时,把这个 id
 * 经此 Context 注入 Provider 树;Repl 在 mount effect 里读一次、调 `doResume(id)` 回灌历史
 * (LLM 半边 reseed + transcript 半边替换),然后再不触发(useRef 去重)。
 *
 * 为什么走 Context 而不是 prop:App 经路由表渲染 `<Screen/>`(无 props 通道),而屏幕组件
 * 需在**首帧挂载后**(runTui 里组件尚未 mount)才能安全触发 transcript 替换。一个只读的
 * 单值 Context 是最小接缝,零逻辑、可单测。`undefined` = 不续接(正常新会话)。
 *
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext } from 'react';

const BootResumeContext = createContext<string | undefined>(undefined);

export function BootResumeProvider(props: {
  /** 已确认有 WAL 历史的续接会话 id;undefined = 不续接。 */
  id?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return <BootResumeContext.Provider value={props.id}>{props.children}</BootResumeContext.Provider>;
}

/** 读启动续接 id(Repl 的 mount effect 用);无则 undefined。 */
export function useBootResume(): string | undefined {
  return useContext(BootResumeContext);
}
