// @desc List shared capability packages across global and team layers
import { relative, join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

type Layer = "instance" | "team";
type PackageInfo = { name: string; layer: Layer; path: string; kinds: string[] };

const KNOWN_KINDS = ["tools", "slots", "plugins"] as const;

export default {
  name: "list_capability_packages",
  description:
    "List shared capability packages from global and team layers (does NOT include the agent's own local capabilities). " +
    "For builders: shows each package name, its layer, and what kinds it contains (tools/slots/plugins). " +
    "To inspect individual capabilities inside a package, read the files directly.",
  input_schema: { type: "object", properties: {} },
  async execute(_args, ctx): Promise<ToolOutput> {
    const layers: { id: Layer; dir: string }[] = [
      { id: "instance", dir: ctx.pathManager.instance().capabilitiesDir() },
      { id: "team", dir: ctx.pathManager.team().capabilitiesDir() },
    ];

    const packages: PackageInfo[] = [];

    for (const { id, dir } of layers) {
      let names: string[];
      try { names = getSandboxFs().readdirSync(dir); } catch { continue; }

      for (const name of names) {
        const st = getSandboxFs().statSync(join(dir, name));
        if (!st?.isDirectory) continue;
        const kinds: string[] = [];
        for (const kind of KNOWN_KINDS) {
          try {
            const files = getSandboxFs().readdirSync(`${dir}/${name}/${kind}`);
            if (files.some((f) => f.endsWith(".ts"))) kinds.push(kind);
          } catch { /* kind dir doesn't exist */ }
        }
        if (kinds.length > 0) {
          packages.push({
            name,
            layer: id,
            path: relative(ctx.pathManager.root(), `${dir}/${name}`),
            kinds,
          });
        }
      }
    }

    packages.sort((a, b) => a.layer.localeCompare(b.layer) || a.name.localeCompare(b.name));

    return JSON.stringify({
      agentId: ctx.agentId,
      packages,
      hint: "Use `read_file` or `list_dir` to inspect individual capabilities inside a package. " +
            "Use `self_capabilities_editor` with `#package_name` to enable/disable a whole package.",
    }, null, 2);
  },
  serial: false,
} satisfies ToolDefinition;
