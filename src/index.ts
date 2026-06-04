/**
 * ReasoniXlaw — Plugin entry point
 *
 * Registers a ContextEngine: "deepseek-prefix-stable"
 *
 * Configuration in openclaw.json:
 * ```json5
 * {
 *   plugins: {
 *     entries: {
 *       "deepseek-harness": {
 *         enabled: true,
 *         config: {
 *           targetModels: ["deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5"]
 *         }
 *       }
 *     },
 *     slots: {
 *       contextEngine: "deepseek-prefix-stable"
 *     }
 *   }
 * }
 * ```
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk";
import { DeepSeekContextEngine } from "./context-engine.js";
import type { DeepSeekHarnessConfig } from "./types.js";

// Public API exports
export { DeepSeekContextEngine } from "./context-engine.js";
export type { DeepSeekHarnessConfig } from "./types.js";
export { estimateTextTokens, estimateMessageTokens, estimateTotalTokens, extractContent, extractToolCallNames } from "./types.js";

const CONTEXT_ENGINE_ID = "deepseek-prefix-stable";
const HARNESS_ID = "deepseek-harness";

/** Read plugin config from openclaw.json → plugins.entries.deepseek-harness.config */
function readPluginConfig(config?: OpenClawConfig): DeepSeekHarnessConfig {
  const entries = (config as unknown as Record<string, unknown>)?.plugins as Record<string, unknown> | undefined;
  const entriesMap = entries?.entries as Record<string, Record<string, unknown>> | undefined;
  const entry = entriesMap?.[HARNESS_ID];
  return (entry?.config as DeepSeekHarnessConfig) ?? {};
}

export default definePluginEntry({
  id: HARNESS_ID,
  name: "DeepSeek Harness",
  description:
    "Prefix-cache stable context engine for DeepSeek models. " +
    "Three-layer context management keeps the prompt prefix locked so " +
    "DeepSeek's prefix cache hits on every turn — up to 90% cost reduction.",

  register(api: OpenClawPluginApi) {
    api.registerContextEngine(CONTEXT_ENGINE_ID, (ctx) => {
      const config = readPluginConfig(ctx.config);
      return new DeepSeekContextEngine(config);
    });

    console.log(`[${HARNESS_ID}] Registered context engine: ${CONTEXT_ENGINE_ID}`);
  },
});
