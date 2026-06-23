/**
 * InkRenderer — modular Ink-based TUI renderer for agenteam.
 * Drop-in replacement for CLIRenderer with the same public interface.
 */

import React from "react";
import Ink from "./ink/ink.js";
import instances from "./ink/instances.js";
import type { RendererCallbacks, RendererDataSource } from "./types.js";
import { InkApp } from "./app.js";

export class InkRenderer {
  private ink: Ink | null = null;
  private onExitCallback: (() => void) | undefined;
  private onInterruptCallback: (() => void) | undefined;
  private onSwitchInstanceCallback: ((id: string) => void) | undefined;
  private _mounted = false;

  constructor(
    private readonly callbacks: RendererCallbacks,
    private readonly dataSource: RendererDataSource,
  ) {
    const stdin = process.stdin as NodeJS.ReadStream;
    if (!stdin.isTTY) {
      process.stderr.write(
        "ink-renderer requires a TTY terminal with raw mode support.\n" +
        "Run in a real terminal, not a piped/non-interactive shell.\n",
      );
      process.exit(1);
    }

    this.ink = new Ink({
      stdout: process.stdout as NodeJS.WriteStream,
      stdin,
      stderr: process.stderr as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    instances.set(process.stdout as NodeJS.WriteStream, this.ink);
  }

  setExitCallback(cb: () => void): void {
    this.onExitCallback = cb;
    this.render();
  }

  setInterruptCallback(cb: (agentId?: string) => void): void {
    this.onInterruptCallback = cb;
    this.render();
  }

  setSwitchInstanceCallback(cb: (id: string) => void): void {
    this.onSwitchInstanceCallback = cb;
    this.render();
  }

  setConnectionState(_connected: boolean): void {
    // kept as no-op for external callers
  }

  async start(): Promise<void> {
    this._mounted = true;
    this.render();
  }

  stop(): void {
    this.ink?.unmount();
    instances.delete(process.stdout as NodeJS.WriteStream);
    this.ink = null;
  }

  private render(): void {
    if (!this.ink || !this._mounted) return;
    this.ink.render(
      React.createElement(InkApp, {
        callbacks: this.callbacks,
        dataSource: this.dataSource,
        onExit: this.onExitCallback,
        onInterrupt: this.onInterruptCallback,
        onSwitchInstance: this.onSwitchInstanceCallback,
      }),
    );
  }
}
