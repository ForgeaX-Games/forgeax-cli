import { createContext } from "react";
import type { OverlaySchedulerResult } from "../hooks/use-overlay-scheduler.js";
import type { RendererCallbacks, RendererDataSource } from "../types.js";

export const ColumnsContext = createContext(80);

export const OverlaySchedulerContext = createContext<OverlaySchedulerResult | null>(null);

export const DataSourceContext = createContext<RendererDataSource | null>(null);

export const CallbacksContext = createContext<RendererCallbacks | null>(null);
