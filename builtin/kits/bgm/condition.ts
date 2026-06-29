/** bgm kit gate.
 *
 *  全局默认 enabled —— 三个工具自己会校验 slug / assetId / resUrl。
 *  如未来想"无活动游戏就隐藏"也只需在这里读上下文决定返回值,
 *  BaseKitLoader 会把它和每个 tool 自己的 condition AND 起来。 */

export default function condition(): boolean {
  return true;
}
