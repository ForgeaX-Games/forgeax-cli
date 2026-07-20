/**
 * 统一的出站请求标识 header。
 *
 * 缺省的 fetch UA(如 `Bun/1.3.10`)过于简陋且不体现来源。
 * 所有 provider 出站请求统一带上 forgeax-cli 自己的 `User-Agent`,
 * 便于上游/网关侧识别与统计。
 *
 * 版本号 SSOT = src/version.ts(派生自 package.json)。
 */
import { FORGEAX_CORE_VERSION } from '../version';

/** 出站 User-Agent,形如 `forgeax-cli/0.1.4 (Bun/1.3.10; darwin arm64)`。 */
export const FORGEAX_USER_AGENT = buildUserAgent();

function buildUserAgent(): string {
  const parts: string[] = [];
  // 运行时(Bun / Node)。
  const bunVer = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  if (bunVer) parts.push(`Bun/${bunVer}`);
  else if (typeof process !== 'undefined' && process.versions?.node) {
    parts.push(`Node/${process.versions.node}`);
  }
  // 平台信息。
  if (typeof process !== 'undefined' && process.platform) {
    parts.push(`${process.platform} ${process.arch ?? ''}`.trim());
  }
  const suffix = parts.length ? ` (${parts.join('; ')})` : '';
  return `forgeax-cli/${FORGEAX_CORE_VERSION}${suffix}`;
}
