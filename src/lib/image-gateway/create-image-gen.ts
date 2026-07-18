/**
 * createImageGen — 编排层对中立 `ImageGen` 能力缝的实现(host capability)。
 *
 * 包一层 ImageDispatcher,按 env 懒构造(首次 generate/isReady 才建,非图像工具
 * 0 成本);由 ToolRegistry 在调用插件后端时注入进 handler ctx,业务插件只消费
 * `@forgeax/types` 的 ImageGen 接口,不反向 import 编排层 vendor 实现。
 */
import type { ImageGen } from '@forgeax/types';
import { ImageDispatcher } from './clients/dispatcher';

export function createImageGen(env: Record<string, string | undefined>): ImageGen {
  let dispatcher: ImageDispatcher | null = null;
  const get = (): ImageDispatcher => (dispatcher ??= new ImageDispatcher(env));
  return {
    generate: (role, opts, preferred) => get().generate(role, opts, preferred),
    isReady: () => get().isReady(),
  };
}
