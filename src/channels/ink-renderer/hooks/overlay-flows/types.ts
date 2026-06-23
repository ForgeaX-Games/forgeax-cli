/** @desc Shared deps for overlay flow builders */

import type { OverlaySchedulerResult } from "../use-overlay-scheduler.js";
import type { RendererDataSource } from "../../types.js";

export interface OverlayFlowDeps {
  scheduler: OverlaySchedulerResult;
  dataSource: RendererDataSource;
  pushSystemMessage: (text: string) => void;
  instanceIdRef: React.RefObject<string>;
  handleInstanceSwitch?: (id: string) => void;
}
