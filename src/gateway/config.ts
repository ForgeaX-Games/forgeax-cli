/** @desc Gateway configuration loader — reads and validates gateway.json */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GatewayRoute {
  externalId: string;
  instanceId: string;
  agentId?: string;
}

export interface GatewayJsonConfig {
  token: string;
  host: string;
  port: number;
  routes?: GatewayRoute[];
  ports?: {
    reserved?: number[];
    dynamicRange?: [number, number];
  };
}

export function loadGatewayConfig(stateDir: string): GatewayJsonConfig {
  const raw = readFileSync(join(stateDir, "gateway.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<GatewayJsonConfig>;

  return {
    token: parsed.token ?? "",
    host: parsed.host ?? "127.0.0.1",
    port: parsed.port ?? 3700,
    routes: parsed.routes,
    ports: parsed.ports,
  };
}
