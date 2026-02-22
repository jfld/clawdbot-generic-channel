import type { OpenClawConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import type { GenericChannelConfig, InboundMessage } from "./types.js";
import { createGenericWSManager, destroyGenericWSManager } from "./client.js";
import { handleGenericMessage } from "./bot.js";

export type MonitorGenericOpts = {
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

let currentWSManager: ReturnType<typeof createGenericWSManager> | null = null;

export async function monitorGenericProvider(opts: MonitorGenericOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Generic monitor");
  }

  const genericCfg = cfg.channels?.["generic-channel"] as GenericChannelConfig | undefined;
  if (!genericCfg?.enabled) {
    throw new Error("Generic channel not enabled");
  }

  const log = opts.runtime?.log ?? console.log;
  const error = opts.runtime?.error ?? console.error;

  const connectionMode = genericCfg.connectionMode ?? "websocket";

  if (connectionMode === "websocket") {
    return monitorWebSocket({ cfg, genericCfg, runtime: opts.runtime, abortSignal: opts.abortSignal });
  }

  log("generic: webhook mode requires HTTP server setup externally");
}

async function monitorWebSocket(params: {
  cfg: OpenClawConfig;
  genericCfg: GenericChannelConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, genericCfg, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log("generic: starting WebSocket server...");

  const wsManager = createGenericWSManager(genericCfg);
  currentWSManager = wsManager;

  const chatHistories = new Map<string, HistoryEntry[]>();

  // Set up message handler
  wsManager.onMessageReceive = async (message: InboundMessage) => {
    try {
      console.log(`generic: received message: ${JSON.stringify(message)}`);
      await handleGenericMessage({
        cfg,
        message,
        runtime,
        chatHistories,
      });
    } catch (err) {
      error(`generic: error handling message: ${String(err)}`);
    }
  };

  // Start the WebSocket server
  wsManager.start();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (currentWSManager === wsManager) {
        destroyGenericWSManager();
        currentWSManager = null;
      }
    };

    const handleAbort = () => {
      log("generic: abort signal received, stopping WebSocket server");
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // The WebSocket server runs indefinitely until aborted
    log("generic: WebSocket server is running");
  });
}

export function stopGenericMonitor(): void {
  if (currentWSManager) {
    destroyGenericWSManager();
    currentWSManager = null;
  }
}
