/** persona kit gate.
 *
 *  全局默认开启；slot 自身在拿不到 personaFile / 文件读不到时返回 null，把
 *  整个 kit 关掉的成本远高于让 slot 自己安静退出，所以这里恒真。 */

import type { AgentContext } from "../../../src/core/types";

export default function condition(_ctx: AgentContext): boolean {
  return true;
}
