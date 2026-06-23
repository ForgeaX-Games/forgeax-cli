/** 共享 deprecation 工具。
 *
 *  使用场景：
 *  1. **健康的临时 endpoint**（`deprecation(...)`）—— endpoint 仍然能干活，
 *     但响应头携带 `Deprecation: true` + `Sunset: ...` + 迁移路径，让前端
 *     按 RFC 8594 提示用户。常用于 `/api/cli` 这种过渡接口。
 *  2. **已被移除的 endpoint**（`gone410(...)`）—— 直接返 410 + JSON 提示新路径，
 *     避免 silent 404 误导调试。 */

import type { MiddlewareHandler } from "hono";

export interface DeprecationOpts {
  /** ISO 日期或里程碑名（"forgeax-v1.0" / "2026-08-01"）。 */
  sunset: string;
  reason: string;
  /** 推荐迁移到哪个新路径，例如 `/api/commands/send_message/execute`。 */
  migration?: string;
}

export function deprecation(opts: DeprecationOpts): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set("Deprecation", "true");
    c.res.headers.set("Sunset", opts.sunset);
    c.res.headers.set("X-ForgeaX-Lifecycle", "temporary");
    c.res.headers.set("X-ForgeaX-Deprecation-Reason", opts.reason);
    if (opts.migration) c.res.headers.set("X-ForgeaX-Migration", opts.migration);
  };
}

export function gone410(opts: { migration: string; hint: string }): MiddlewareHandler {
  return async (c) => {
    c.res.headers.set("X-ForgeaX-Migration", opts.migration);
    return c.json(
      { ok: false, error: "endpoint removed", migration: opts.migration, hint: opts.hint },
      410,
    );
  };
}
