// @desc Default agenteam.json global config template

import type { AgentTeamConfig } from "../../core/types.js";

export const DEFAULT_AGENTEAM_JSON: AgentTeamConfig = {
  models: {
    model: "",
    maxRetries: 3,
    timeout: -1,
  },
  sandbox: {
    sshKeyPath: "",
    sshPort: 22,
  },
};
