import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_RELAY_CONFIG, matchRelay, mergeRelayConfig, type RelayConfig } from "./relay.ts";

const EXTENSION_ID = "fast";
const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_API_ID = "anthropic-messages";
const ANTHROPIC_OFFICIAL_ORIGIN = "https://api.anthropic.com";
const ANTHROPIC_FAST_SPEED = "fast";
const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ANTHROPIC_SUPPORTED_MODELS = new Set(["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"]);

const OPENAI_PROVIDER_ID = "openai-codex";
const OPENAI_API_ID = "openai-codex-responses";
const OPENAI_FAST_SERVICE_TIER = "priority";
const OPENAI_SUPPORTED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
]);
const OPENAI_API_PROVIDER_ID = "openai";
const OPENAI_API_IDS = new Set(["openai-responses", "openai-completions"]);
const OPENAI_API_FAST_SERVICE_TIER = "fast";
const OPENAI_API_SUPPORTED_MODELS = new Set([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
]);
const OPENAI_ULTRAFAST_MODEL = "gpt-6-astra";
const OPENAI_ULTRAFAST_API_ID = "openai-responses";
const OPENAI_ULTRAFAST_SERVICE_TIER = "ultrafast";
const OPENAI_CANONICAL_BASE_URL = "https://api.openai.com/v1";

const DEFAULT_CONFIG: FastConfig = {
  enabled: false,
  showStatus: true,
  relay: DEFAULT_RELAY_CONFIG,
};

type FastOverride = "auto" | "on" | "off";
type FastProvider = "anthropic" | "openai";

type FastConfig = {
  /** Default Fast-mode state when there is no session override. */
  enabled: boolean;
  /** Show a compact `fast` status when Fast mode is active for the current model. */
  showStatus: boolean;
  /** Automatic OpenAI-compatible relay support, with optional allowlists. */
  relay: RelayConfig;
  /** Internal load error; malformed config disables all Fast injection. */
  error?: string;
};

type SessionState = {
  config: FastConfig;
  override: FastOverride;
  /** Session-only Ultrafast selection; never loaded from configuration. */
  ultrafast: boolean;
  injectionCount: number;
  lastRequestStatus?: string;
  lastInjectedAt?: number;
  lastInjectedModel?: string;
};

type ProjectConfigContext = {
  cwd: string;
  isProjectTrusted?: () => boolean;
};

type PayloadRecord = Record<string, unknown>;

type AnthropicHeaderCompat = {
  forceAdaptiveThinking?: boolean;
  supportsEagerToolInputStreaming?: boolean;
};

type Eligibility = {
  eligible: boolean;
  modelKey: string;
  provider?: FastProvider;
  serviceTier?: string;
  relay?: boolean;
  reason?: string;
};

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    // Do not echo parser errors: they can contain configuration secrets.
    throw new Error(`Could not read valid JSON from ${path}`);
  }
  if (!isPayloadRecord(parsed)) throw new Error(`Expected a JSON object in ${path}`);
  return parsed;
}

function mergeConfig(base: FastConfig, overrides: Record<string, unknown>): FastConfig {
  const known = new Set(["enabled", "showStatus", "relay"]);
  if (Object.keys(overrides).some((key) => !known.has(key))) {
    throw new Error("Unknown fast configuration field");
  }
  for (const key of ["enabled", "showStatus"] as const) {
    if (key in overrides && typeof overrides[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  return {
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : base.enabled,
    showStatus: typeof overrides.showStatus === "boolean" ? overrides.showStatus : base.showStatus,
    relay: mergeRelayConfig(base.relay, overrides.relay),
  };
}

function canReadProjectConfig(ctx: ProjectConfigContext): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

function samePath(a: string, b: string): boolean {
  const [left, right] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Search upward for a project config, stopping before the home directory, whose config dir is the user's own. */
function findProjectConfigPath(cwd: string): string {
  const home = homedir();
  let current = cwd;
  while (!samePath(current, home)) {
    const candidate = join(current, CONFIG_DIR_NAME, "fast.json");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(cwd, CONFIG_DIR_NAME, "fast.json");
}

function loadConfig(ctx: ProjectConfigContext): FastConfig {
  try {
    const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "fast.json"));
    const projectConfig = canReadProjectConfig(ctx)
      ? readConfigFile(findProjectConfigPath(ctx.cwd))
      : {};
    return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid fast configuration";
    console.error(`Fast injection disabled: ${message}`);
    return { ...DEFAULT_CONFIG, error: message };
  }
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isFastEnabled(state: SessionState): boolean {
  if (state.config.error) return false;
  if (state.override === "on") return true;
  if (state.override === "off") return false;
  return state.config.enabled;
}

function describeMode(state: SessionState): string {
  if (state.override === "on") return "on (session override)";
  if (state.override === "off") return "off (session override)";
  return state.config.enabled ? "on (config default)" : "off (config default)";
}

function getEligibility(ctx: ExtensionContext, config: FastConfig): Eligibility {
  const model = ctx.model;
  if (!model) {
    return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
  }

  const key = `${model.provider}/${model.id}`;
  if (config.error) return { eligible: false, modelKey: key, reason: config.error };
  const relay = matchRelay(model, config.relay);
  // Relay exclusions must not fall through to official rules for an overridden endpoint.
  if (relay.targeted) {
    return {
      eligible: relay.eligible,
      modelKey: key,
      provider: "openai",
      serviceTier: config.relay.serviceTier,
      relay: true,
      reason: relay.reason,
    };
  }
  if (model.provider === ANTHROPIC_PROVIDER_ID) {
    if (model.api !== ANTHROPIC_API_ID) {
      return {
        eligible: false,
        modelKey: key,
        reason: `current API is ${model.api}, not ${ANTHROPIC_API_ID}`,
      };
    }

    if (!isOfficialAnthropicEndpoint(model.baseUrl)) {
      return {
        eligible: false,
        modelKey: key,
        reason: `Fast mode requires the official endpoint ${ANTHROPIC_OFFICIAL_ORIGIN}`,
      };
    }

    if (!ANTHROPIC_SUPPORTED_MODELS.has(model.id)) {
      return {
        eligible: false,
        modelKey: key,
        reason: "Fast mode is only enabled for Claude Opus 4.8, Claude Opus 5, and Claude Opus 5.5",
      };
    }

    return { eligible: true, modelKey: key, provider: "anthropic" };
  }

  if (model.provider === OPENAI_PROVIDER_ID) {
    if (model.api !== OPENAI_API_ID) {
      return {
        eligible: false,
        modelKey: key,
        reason: `current API is ${model.api}, not ${OPENAI_API_ID}`,
      };
    }

    if (!OPENAI_SUPPORTED_MODELS.has(model.id)) {
      return {
        eligible: false,
        modelKey: key,
        reason: "Fast mode is not enabled for this OpenAI Codex model",
      };
    }

    let usingOAuth = false;
    try {
      usingOAuth = ctx.modelRegistry.isUsingOAuth(model);
    } catch {
      // An unavailable registry snapshot is not evidence of subscription auth.
    }
    if (!usingOAuth) {
      return {
        eligible: false,
        modelKey: key,
        reason: "ChatGPT OAuth auth is required; API-key auth is intentionally not used",
      };
    }

    return {
      eligible: true,
      modelKey: key,
      provider: "openai",
      serviceTier: OPENAI_FAST_SERVICE_TIER,
    };
  }

  if (model.provider === OPENAI_API_PROVIDER_ID) {
    if (!OPENAI_API_IDS.has(model.api)) {
      return {
        eligible: false,
        modelKey: key,
        reason: `current API is ${model.api}, not openai-responses or openai-completions`,
      };
    }

    if (!OPENAI_API_SUPPORTED_MODELS.has(model.id)) {
      return {
        eligible: false,
        modelKey: key,
        reason:
          "Fast mode is only enabled for GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna on direct OpenAI APIs",
      };
    }

    return {
      eligible: true,
      modelKey: key,
      provider: "openai",
      serviceTier: OPENAI_API_FAST_SERVICE_TIER,
    };
  }

  return {
    eligible: false,
    modelKey: key,
    reason: `current provider ${model.provider} does not support this extension's Fast mode`,
  };
}

/** Third-party Anthropic endpoints are outside this extension's support. Compare parsed origins. */
function isOfficialAnthropicEndpoint(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.origin === ANTHROPIC_OFFICIAL_ORIGIN;
  } catch {
    return false;
  }
}

function isCanonicalOpenAIEndpoint(baseUrl: unknown): boolean {
  return baseUrl === OPENAI_CANONICAL_BASE_URL || baseUrl === `${OPENAI_CANONICAL_BASE_URL}/`;
}

function getUltrafastEligibility(ctx: ExtensionContext): Eligibility {
  const model = ctx.model;
  if (!model) {
    return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
  }

  const key = `${model.provider}/${model.id}`;
  if (model.provider !== OPENAI_API_PROVIDER_ID) {
    return {
      eligible: false,
      modelKey: key,
      reason: "Ultrafast mode requires the direct OpenAI provider",
    };
  }

  if (model.api !== OPENAI_ULTRAFAST_API_ID) {
    return {
      eligible: false,
      modelKey: key,
      reason: `Ultrafast mode requires API ${OPENAI_ULTRAFAST_API_ID}`,
    };
  }

  if (model.id !== OPENAI_ULTRAFAST_MODEL) {
    return {
      eligible: false,
      modelKey: key,
      reason: `Ultrafast mode is only enabled for ${OPENAI_ULTRAFAST_MODEL}`,
    };
  }

  if (!isCanonicalOpenAIEndpoint(model.baseUrl)) {
    return {
      eligible: false,
      modelKey: key,
      reason: `Ultrafast mode requires the canonical endpoint ${OPENAI_CANONICAL_BASE_URL}`,
    };
  }

  try {
    if (ctx.modelRegistry.isUsingOAuth(model)) {
      return {
        eligible: false,
        modelKey: key,
        reason: "Ultrafast mode requires direct OpenAI API-key auth; OAuth is unsupported",
      };
    }
  } catch {
    return {
      eligible: false,
      modelKey: key,
      reason: "Ultrafast mode requires direct OpenAI API-key auth; auth could not be verified",
    };
  }

  return {
    eligible: true,
    modelKey: key,
    provider: "openai",
    serviceTier: OPENAI_ULTRAFAST_SERVICE_TIER,
  };
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
  if (!ctx.hasUI) return;
  if (!state.config.showStatus) {
    ctx.ui.setStatus(EXTENSION_ID, undefined);
    return;
  }

  if (state.ultrafast) {
    const eligibility = getUltrafastEligibility(ctx);
    ctx.ui.setStatus(EXTENSION_ID, eligibility.eligible ? "ultrafast" : undefined);
    return;
  }

  const eligibility = getEligibility(ctx, state.config);
  ctx.ui.setStatus(EXTENSION_ID, isFastEnabled(state) && eligibility.eligible ? "fast" : undefined);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
  const relayConfig = state.config.relay;
  const relaySummary = ` Relay: ${relayConfig.mode}; models=${relayConfig.models.join(", ") || "all"};` +
    ` service_tier=${relayConfig.serviceTier}; overwrite=${relayConfig.overwriteServiceTier}.` +
    (relayConfig.mode === "allowlist"
      ? ` Providers: ${relayConfig.providers.join(", ") || "none"}; base URL targets: ${relayConfig.baseURLs.length}.`
      : "");
  const injected = ` Injected requests: ${state.injectionCount}.` + (state.lastInjectedAt
    ? ` Last injected for ${state.lastInjectedModel ?? "unknown model"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
    : "") + (state.lastRequestStatus ? ` Last request: ${state.lastRequestStatus}.` : "") + relaySummary;
  if (state.config.error) {
    return `Fast injection disabled by configuration error: ${state.config.error}. Fix fast.json and /reload.${injected}`;
  }

  if (state.ultrafast) {
    const eligibility = getUltrafastEligibility(ctx);
    if (eligibility.eligible) {
      return `Ultrafast mode is on (session only) and eligible for ${eligibility.modelKey}; requested service_tier=${OPENAI_ULTRAFAST_SERVICE_TIER}. Provider pricing may include a premium that Pi's cost display does not reflect. Check your provider's current pricing.${injected}`;
    }
    return `Ultrafast mode is on (session only), but not eligible for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
  }

  const enabled = isFastEnabled(state);
  const eligibility = getEligibility(ctx, state.config);
  const active = enabled && eligibility.eligible;

  if (active) {
    const wireSetting =
      eligibility.provider === "anthropic"
        ? `speed=${ANTHROPIC_FAST_SPEED}`
        : `service_tier=${eligibility.serviceTier}`;
    const policy = eligibility.relay && state.config.relay.overwriteServiceTier
      ? "existing service_tier will be overwritten" : "existing tier/speed fields are preserved";
    return `Fast mode is ${describeMode(state)} and eligible for ${eligibility.modelKey}${eligibility.relay ? " (relay)" : ""}; requesting ${wireSetting}; ${policy}. Injection does not confirm upstream acceptance or pricing.${injected}`;
  }

  if (enabled) {
    return `Fast mode is ${describeMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
  }

  return `Fast mode is ${describeMode(state)}. Current model: ${eligibility.modelKey}; ${eligibility.eligible
    ? "eligible" : `ineligible (${eligibility.reason})`}.${injected}`;
}

function splitBetaHeader(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function isAnthropicOAuth(ctx: ExtensionContext): Promise<boolean> {
  try {
    const resolution = await ctx.modelRegistry.getProviderAuth(ANTHROPIC_PROVIDER_ID);
    const apiKey = resolution?.auth.apiKey;
    if (typeof apiKey === "string") return apiKey.includes("sk-ant-oat");
  } catch {
    // Fall back to the synchronous registry snapshot below.
  }

  return ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
}

function getAnthropicProviderBetas(ctx: ExtensionContext, hasActiveTools: boolean): string[] {
  const model = ctx.model;
  if (!model) return [];
  const compat = model.compat as AnthropicHeaderCompat | undefined;

  const betas: string[] = [];
  if (hasActiveTools && compat?.supportsEagerToolInputStreaming === false) {
    betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (compat?.forceAdaptiveThinking !== true) {
    betas.push(INTERLEAVED_THINKING_BETA);
  }
  return betas;
}

async function injectAnthropicFastHeader(
  headers: Record<string, string | null>,
  ctx: ExtensionContext,
  state: SessionState,
  hasActiveTools: boolean,
): Promise<void> {
  if (state.ultrafast || !isFastEnabled(state)) return;
  const eligibility = getEligibility(ctx, state.config);
  if (!eligibility.eligible || eligibility.provider !== "anthropic") return;

  const matchingKeys = Object.keys(headers).filter(
    (name) => name.toLowerCase() === "anthropic-beta",
  );
  const existing = matchingKeys.flatMap((name) => splitBetaHeader(headers[name]));
  const matchingModelEntries = Object.entries(ctx.model?.headers ?? {}).filter(
    ([name]) => name.toLowerCase() === "anthropic-beta",
  );
  const modelBetas = matchingModelEntries.flatMap(([, value]) => splitBetaHeader(value));
  const providerBetas = getAnthropicProviderBetas(ctx, hasActiveTools);
  const oauthBetas = (await isAnthropicOAuth(ctx)) ? CLAUDE_CODE_OAUTH_BETAS : [];
  const next = Array.from(
    new Set([...modelBetas, ...existing, ...oauthBetas, ...providerBetas, ANTHROPIC_FAST_BETA]),
  );

  for (const key of matchingKeys) delete headers[key];
  const outputKey = matchingModelEntries.at(-1)?.[0] ?? "anthropic-beta";
  headers[outputKey] = next.join(",");
}

function injectUltrafastPayload(
  payload: unknown,
  ctx: ExtensionContext,
  state: SessionState,
): PayloadRecord | undefined {
  if (!state.ultrafast) return undefined;
  const eligibility = getUltrafastEligibility(ctx);
  if (!eligibility.eligible || !eligibility.serviceTier) return undefined;
  if (!isPayloadRecord(payload) || payload.model !== ctx.model?.id) {
    state.lastRequestStatus = "skipped (malformed payload or model mismatch)";
    return undefined;
  }
  if ("service_tier" in payload) {
    state.lastRequestStatus = "skipped (existing service_tier preserved)";
    return undefined;
  }

  recordInjection(state, eligibility);
  return { ...payload, service_tier: eligibility.serviceTier };
}

function recordInjection(state: SessionState, eligibility: Eligibility): void {
  state.injectionCount += 1;
  state.lastInjectedAt = Date.now();
  state.lastInjectedModel = eligibility.modelKey;
  state.lastRequestStatus = eligibility.provider === "anthropic"
    ? `injected speed=${ANTHROPIC_FAST_SPEED}` : `injected service_tier=${eligibility.serviceTier}`;
}

function injectFastPayload(
  payload: unknown,
  ctx: ExtensionContext,
  state: SessionState,
): PayloadRecord | undefined {
  if (state.ultrafast || !isFastEnabled(state)) {
    state.lastRequestStatus = "skipped (Fast is off or config is invalid)";
    return undefined;
  }
  const eligibility = getEligibility(ctx, state.config);
  if (!eligibility.eligible || !eligibility.provider) {
    state.lastRequestStatus = `skipped (${eligibility.reason ?? "ineligible model"})`;
    return undefined;
  }
  if (!isPayloadRecord(payload) || payload.model !== ctx.model?.id) {
    state.lastRequestStatus = "skipped (malformed payload or model mismatch)";
    return undefined;
  }

  if (eligibility.provider === "anthropic") {
    if ("speed" in payload) {
      state.lastRequestStatus = "skipped (existing speed preserved)";
      return undefined;
    }
    recordInjection(state, eligibility);
    return { ...payload, speed: ANTHROPIC_FAST_SPEED };
  }

  if ("service_tier" in payload) {
    if (payload.service_tier === eligibility.serviceTier) {
      state.lastRequestStatus = "unchanged (requested service_tier already present)";
      return undefined;
    }
    if (!eligibility.relay || !state.config.relay.overwriteServiceTier) {
      state.lastRequestStatus = "skipped (existing service_tier preserved)";
      return undefined;
    }
  }
  if (!eligibility.serviceTier) return undefined;
  recordInjection(state, eligibility);
  return { ...payload, service_tier: eligibility.serviceTier };
}

function disableUltrafast(ctx: ExtensionContext, state: SessionState, reason?: string): void {
  state.ultrafast = false;
  // Do not fall back to ordinary Fast when a selected Ultrafast model becomes ineligible.
  state.override = "off";
  updateStatus(ctx, state);
  if (reason && ctx.hasUI) {
    ctx.ui.notify(
      `Ultrafast mode disabled: ${reason}. It remains off until manually enabled.`,
      "warning",
    );
  }
}

function toggleUltrafast(ctx: ExtensionContext, state: SessionState): void {
  if (state.config.error) {
    ctx.ui.notify(getStatusMessage(ctx, state), "error");
    return;
  }
  if (state.ultrafast) {
    disableUltrafast(ctx, state);
    ctx.ui.notify(
      "Ultrafast mode is off (session only); regular Fast remains off until /fast is toggled.",
      "info",
    );
    return;
  }

  const eligibility = getUltrafastEligibility(ctx);
  if (!eligibility.eligible) {
    ctx.ui.notify(
      `Cannot enable Ultrafast mode for ${eligibility.modelKey}: ${eligibility.reason}.`,
      "error",
    );
    return;
  }

  state.ultrafast = true;
  updateStatus(ctx, state);
  ctx.ui.notify(getStatusMessage(ctx, state), "info");
}

export default function fastExtension(pi: ExtensionAPI) {
  const states = new WeakMap<object, SessionState>();

  function getState(ctx: ExtensionContext): SessionState {
    let state = states.get(ctx.sessionManager);
    if (!state) {
      state = {
        config: loadConfig(ctx),
        override: "auto",
        ultrafast: false,
        injectionCount: 0,
      };
      states.set(ctx.sessionManager, state);
    }
    return state;
  }

  pi.on("session_start", (_event, ctx) => {
    const state: SessionState = {
      config: loadConfig(ctx),
      override: "auto",
      ultrafast: false,
      injectionCount: 0,
    };
    states.set(ctx.sessionManager, state);
    updateStatus(ctx, state);
  });

  pi.on("model_select", (_event, ctx) => {
    const state = getState(ctx);
    if (state.ultrafast) {
      const eligibility = getUltrafastEligibility(ctx);
      if (!eligibility.eligible) {
        disableUltrafast(
          ctx,
          state,
          `the selected model ${eligibility.modelKey} is unsupported (${eligibility.reason})`,
        );
        return;
      }
    }
    updateStatus(ctx, state);
  });

  pi.on("before_provider_headers", async (event, ctx) => {
    const hasActiveTools =
      typeof pi.getActiveTools === "function" && pi.getActiveTools().length > 0;
    await injectAnthropicFastHeader(event.headers, ctx, getState(ctx), hasActiveTools);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const state = getState(ctx);
    if (state.ultrafast) {
      const eligibility = getUltrafastEligibility(ctx);
      if (!eligibility.eligible) {
        disableUltrafast(
          ctx,
          state,
          `the current model ${eligibility.modelKey} is unsupported (${eligibility.reason})`,
        );
        return undefined;
      }
      const nextPayload = injectUltrafastPayload(event.payload, ctx, state);
      updateStatus(ctx, state);
      return nextPayload;
    }

    const nextPayload = injectFastPayload(event.payload, ctx, state);
    updateStatus(ctx, state);
    return nextPayload;
  });

  pi.registerCommand("ultrafast", {
    description: "Toggle session-only Ultrafast mode for direct OpenAI API-key GPT-6 Astra",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /ultrafast", "warning");
        return;
      }
      toggleUltrafast(ctx, getState(ctx));
    },
  });

  pi.registerCommand("fast", {
    description:
      "Toggle or inspect Fast mode for official providers and OpenAI-compatible relays",
    getArgumentCompletions: (prefix) => {
      const actions = ["on", "off", "toggle", "status", "ultrafast"];
      return actions.filter((action) => action.startsWith(prefix.toLowerCase()))
        .map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      const state = getState(ctx);
      const action = args.trim().toLowerCase();

      if (action === "ultrafast") {
        toggleUltrafast(ctx, state);
        return;
      }

      if (action === "status") {
        ctx.ui.notify(getStatusMessage(ctx, state), "info");
        return;
      }

      if (action === "on" || action === "off") {
        state.ultrafast = false;
        state.override = action;
        updateStatus(ctx, state);
        ctx.ui.notify(getStatusMessage(ctx, state), "info");
        return;
      }

      if (!action || action === "toggle") {
        if (state.ultrafast) {
          toggleUltrafast(ctx, state);
          return;
        }
        state.override = isFastEnabled(state) ? "off" : "on";
        updateStatus(ctx, state);
        ctx.ui.notify(getStatusMessage(ctx, state), "info");
        return;
      }

      ctx.ui.notify("Usage: /fast [on|off|toggle|status|ultrafast]", "warning");
    },
  });
}
