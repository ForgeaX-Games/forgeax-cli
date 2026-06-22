// @desc Default pack.json template & type

export type SandboxMode = "direct" | "headless" | "desktop";

/** A declared mount point in pack.json sandbox.mounts */
export interface PackMount {
  /** Identifier used during loadPackToTeam to prompt user for host_path */
  name: string;
  /** Target path inside the container */
  path: string;
  /** Human-readable description shown to user during setup */
  description?: string;
  /** Whether the mount is read-write (default: true). false → SSHFS `-o ro` */
  writable?: boolean;
  /** Whether the mount is optional (default: false). Optional mounts can be skipped by user */
  optional?: boolean;
}

export interface PackJson {
  id: string;
  version?: string;
  description?: string;
  default_agent?: string;
  sandbox?: {
    mode?: SandboxMode;
    hostGateway?: boolean;
    ports?: number[];
    mounts?: PackMount[];
    dockerRun?: {
      shmSize?: string;
      seccomp?: string;
      capAdd?: string[];
      gpus?: string;
      extraArgs?: string[];
    };
  };
}

export const DEFAULT_PACK_JSON: PackJson = {
  id: "my-pack",
  version: "1.0.0",
  description: "A AgenTeam-OS pack.",
  default_agent: "admin",
  sandbox: {
    mode: "headless" as SandboxMode,
    hostGateway: true,
    ports: [6901] as number[],
    mounts: [] as PackMount[],
    dockerRun: {
      shmSize: "1g",
      seccomp: "unconfined",
      capAdd: [] as string[],
      gpus: "",
      extraArgs: [] as string[],
    },
  },
};
