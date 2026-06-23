#!/usr/bin/env node
/** @desc Gateway CLI client — talks to a running Gateway via HTTP API */

import { loadConnInfo, die } from "./http.js";

import * as inst from "./instance.js";
import * as instQuery from "./instance-query.js";
import * as team from "./team.js";
import * as pack from "./pack.js";
import * as agent from "./agent.js";
import * as key from "./key.js";
import * as gw from "./gateway.js";

// ─── Help ───

const HELP = `ForgeaX Gateway CLI

Usage: agenteam <command> [args]

Instance:
  instance list                   List all instances
  instance add <id>               Add and start a new instance
  instance detail <id>            Show instance detail (status, ports, etc.)
  instance start <id>             Start a stopped instance
  instance stop <id>              Stop a running instance (container preserved)
  instance restart <id>           Restart instance subprocess (stop + re-fork)
  instance shutdown <id>          Shut down a single instance
  instance sync <id>              Sync instance code from main (git fetch + merge)
  instance interrupt <id>         Interrupt all running agents
  instance free <id>              Stop + delete workspace entirely
  instance ports <id>             Show port mappings

Instance Query:
  instance tree <id>              Show agent tree hierarchy
  instance board <id> [--agent <agentId>]
                                  Show teamboard variables (optionally for one agent)
  instance agent-json <id> <agentId>
                                  Show agent.json private config for an agent
  instance sessions <id> --agent <agentId>
                                  List sessions for an agent
  instance session-events <id> <agentId>
                                  Dump raw session events for an agent

Team:
  instance info <id>              Show team info and backups
  instance load <id> <pack> [--fork]
                                  Load a pack into the instance's team
  instance save <id> <name>       Save current team to a backup
  instance restore <id> <backup>  Restore a backup to the instance's team
  instance update <id>            Update team from source pack (version check)
  instance manifest <id>          Show team manifest
  instance manifest-update <id> '<json>'
                                  Update team manifest with JSON
  instance delete-backup <id> <name>
                                  Delete a team backup zip
  instance rm-containers <id>     Remove team Docker containers
  instance sync-pack <id> [major|minor|patch]
                                  Sync team changes back to source pack

Pack:
  pack list                       List all packs
  pack add <source>               Install pack from URL or local path
  pack build <id> [--force]       Build a pack (mode from pack.json)
  pack create <id> [--template <basic|platform>]
                                  Create a new empty pack
  pack remove <id>                Remove pack (files + Docker image)
  pack fork <sourceId> <newId>    Fork a pack (git clone + new id)
  pack pull <forkId>              Pull updates from source pack (git fetch + merge)
  pack push <forkId>              Push changes to source pack (git push)

Agent:
  agents [--instance <id>]        List agents (default instance if omitted)
  chat <agentId> "msg"            Send a message to an agent
    [--instance <id>]

Key:
  key llm list                    List LLM key sections (masked)
  key llm add --section <name> --key <api_key> --api <adapter> [--base <url>]
                                  Add a new LLM key section
  key llm update <section> [--key <k>] [--api <a>] [--base <url>]
                                  Update an existing LLM key section
  key llm delete <section>        Delete a LLM key section
  key llm test <section>          Test connectivity for a LLM key
  key tool list                   List tool keys (masked)
  key tool add <key> [value]      Add a tool key
  key tool update <key> <value>   Update a tool key
  key tool delete <key>           Delete a tool key

Model:
  model list                      List model configs
  model update <model> '<json>'   Update a model config
  model delete <model>            Delete a model config

Renderer:
  renderer [instance]             Launch ink-renderer TUI (interactive)

Gateway:
  status                          Show gateway health and uptime
  shutdown                        Shut down the gateway
  restart                         Restart the gateway

Environment:
  AGENTEAM_STATE_DIR              Override ~/.agenteam location
`;

// ─── Main ───

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== "--");
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }

  const cmd = args[0] ?? "renderer";
  const rest = args[0] === undefined ? [] : args.slice(1);

  if (cmd === "renderer") {
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    await import("../ink-renderer.js");
    return;
  }

  let conn: ReturnType<typeof loadConnInfo>;
  try {
    conn = loadConnInfo();
  } catch (err: any) {
    die(`Cannot read gateway.json: ${err.message}\nIs the Gateway running? Start it with: pnpm start`);
  }

  try {
    switch (cmd) {
      case "status":
        await gw.cmdStatus(conn);
        break;
      case "instance": {
        const sub = rest[0];
        const subArgs = rest.slice(1);
        switch (sub) {
          // instance lifecycle
          case "list": await inst.cmdInstances(conn); break;
          case "add": await inst.cmdInstanceAdd(conn, subArgs); break;
          case "detail": await inst.cmdInstanceDetail(conn, subArgs); break;
          case "start": await inst.cmdInstanceStart(conn, subArgs); break;
          case "stop": await inst.cmdInstanceStop(conn, subArgs); break;
          case "restart": await inst.cmdInstanceRestart(conn, subArgs); break;
          case "shutdown": await inst.cmdInstanceShutdown(conn, subArgs); break;
          case "free": await inst.cmdInstanceFree(conn, subArgs); break;
          case "sync": await inst.cmdInstanceSync(conn, subArgs); break;
          case "interrupt": await inst.cmdInstanceInterrupt(conn, subArgs); break;
          case "ports": await inst.cmdInstancePorts(conn, subArgs); break;
          // instance query
          case "tree": await instQuery.cmdInstanceTree(conn, subArgs); break;
          case "board": await instQuery.cmdInstanceBoard(conn, subArgs); break;
          case "agent-json": await instQuery.cmdInstanceAgentJson(conn, subArgs); break;
          case "sessions": await instQuery.cmdInstanceSessions(conn, subArgs); break;
          case "session-events": await instQuery.cmdInstanceSessionEvents(conn, subArgs); break;
          // team
          case "info": await team.cmdInstanceInfo(conn, subArgs); break;
          case "load": await team.cmdInstanceLoad(conn, subArgs); break;
          case "save": await team.cmdInstanceSave(conn, subArgs); break;
          case "restore": await team.cmdInstanceRestore(conn, subArgs); break;
          case "update": await team.cmdInstanceUpdate(conn, subArgs); break;
          case "manifest": await team.cmdInstanceManifest(conn, subArgs); break;
          case "manifest-update": await team.cmdInstanceManifestUpdate(conn, subArgs); break;
          case "delete-backup": await team.cmdInstanceDeleteBackup(conn, subArgs); break;
          case "rm-containers": await team.cmdInstanceRmContainers(conn, subArgs); break;
          case "sync-pack": await team.cmdInstanceSyncPack(conn, subArgs); break;
          default: die(`Unknown instance subcommand: ${sub}\nRun 'agenteam --help' for usage.`);
        }
        break;
      }
      case "agents":
        await agent.cmdAgents(conn, rest);
        break;
      case "chat":
        await agent.cmdChat(conn, rest);
        break;
      case "pack": {
        const sub = rest[0];
        const subArgs = rest.slice(1);
        switch (sub) {
          case "list": await pack.cmdPacks(conn); break;
          case "add": await pack.cmdPackAdd(conn, subArgs); break;
          case "build": await pack.cmdPackBuild(conn, subArgs); break;
          case "create": await pack.cmdPackCreate(conn, subArgs); break;
          case "remove": await pack.cmdPackRemove(conn, subArgs); break;
          case "clean-image": await pack.cmdPackCleanImage(conn, subArgs); break;
          case "fork": await pack.cmdPackFork(conn, subArgs); break;
          case "pull": await pack.cmdPackPull(conn, subArgs); break;
          case "push": await pack.cmdPackPush(conn, subArgs); break;
          default: die(`Unknown pack subcommand: ${sub}\nRun 'agenteam --help' for usage.`);
        }
        break;
      }
      case "shutdown":
        await gw.cmdShutdown(conn);
        break;
      case "restart":
        await gw.cmdRestart(conn);
        break;
      case "key": {
        const sub = rest[0];
        const subArgs = rest.slice(1);
        if (sub === "llm") {
          const llmSub = subArgs[0];
          const llmArgs = subArgs.slice(1);
          switch (llmSub) {
            case "list": case undefined: await key.cmdKeysLlmList(conn); break;
            case "add": await key.cmdKeysLlmAdd(conn, llmArgs); break;
            case "update": await key.cmdKeysLlmUpdate(conn, llmArgs); break;
            case "delete": await key.cmdKeysLlmDelete(conn, llmArgs); break;
            case "test": await key.cmdKeysLlmTest(conn, llmArgs); break;
            default: die(`Unknown key llm subcommand: ${llmSub}\nRun 'agenteam --help' for usage.`);
          }
        } else if (sub === "tool") {
          const toolSub = subArgs[0];
          const toolArgs = subArgs.slice(1);
          switch (toolSub) {
            case "list": case undefined: await key.cmdKeysToolsList(conn); break;
            case "add": await key.cmdKeysToolsAdd(conn, toolArgs); break;
            case "update": await key.cmdKeysToolsUpdate(conn, toolArgs); break;
            case "delete": await key.cmdKeysToolsDelete(conn, toolArgs); break;
            default: die(`Unknown key tool subcommand: ${toolSub}\nRun 'agenteam --help' for usage.`);
          }
        } else {
          die(`Unknown key subcommand: ${sub}\nUse: llm | tool`);
        }
        break;
      }
      case "model": {
        const sub = rest[0];
        const subArgs = rest.slice(1);
        switch (sub) {
          case "list": case undefined: await key.cmdModelsList(conn); break;
          case "update": await key.cmdModelsUpdate(conn, subArgs); break;
          case "delete": await key.cmdModelsDelete(conn, subArgs); break;
          default: die(`Unknown model subcommand: ${sub}\nRun 'agenteam --help' for usage.`);
        }
        break;
      }
      default:
        die(`Unknown command: ${cmd}\nRun 'agenteam --help' for usage.`);
    }
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      die(`Cannot connect to Gateway at ${conn.host}:${conn.port}\nIs the Gateway running? Start it with: pnpm start`);
    }
    die(err.message ?? String(err));
  }
}

main();
