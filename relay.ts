/** Relay targeting inspired by https://github.com/wbxs2077/opencode-relay-fast.
 * Pi exposes provider identity and a pre-serialization payload hook, so no global
 * fetch wrapper or credential/endpoint rewriting is necessary.
 */
export type RelayConfig = {
  mode: "auto" | "allowlist";
  providers: string[];
  baseURLs: string[];
  models: string[];
  serviceTier: "priority" | "fast";
  overwriteServiceTier: boolean;
};

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  mode: "auto",
  providers: [],
  baseURLs: [],
  models: ["gpt-*"],
  serviceTier: "priority",
  overwriteServiceTier: false,
};

const RELAY_APIS = new Set([
  "openai-responses",
  "openai-completions",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exact origin + base path matching; never match a sibling path or host prefix. */
export function normalizeBaseURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

function readStrings(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  if (!(key in raw)) return [...fallback];
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`relay.${key} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item: string) => item.trim()))];
}

export function mergeRelayConfig(base: RelayConfig, value: unknown): RelayConfig {
  if (value === undefined) return {
    ...base, providers: [...base.providers], baseURLs: [...base.baseURLs], models: [...base.models],
  };
  if (!isRecord(value)) throw new Error("relay must be an object");
  const known = new Set(["mode", "providers", "baseURLs", "models", "serviceTier", "overwriteServiceTier"]);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new Error("Unknown relay configuration field");
  }
  const providers = readStrings(value, "providers", base.providers);
  const baseURLs = readStrings(value, "baseURLs", base.baseURLs);
  // Preserve the opt-in semantics of relay.1 configs, including empty lists.
  const mode = "mode" in value ? value.mode
    : "providers" in value || "baseURLs" in value ? "allowlist" : base.mode;
  if (mode !== "auto" && mode !== "allowlist") {
    throw new Error('relay.mode must be "auto" or "allowlist"');
  }
  if (baseURLs.some((url) => normalizeBaseURL(url) === undefined)) {
    throw new Error("relay.baseURLs must be HTTP(S) base URLs without credentials, query or fragment");
  }
  const models = readStrings(value, "models", base.models);
  const serviceTier = "serviceTier" in value ? value.serviceTier : base.serviceTier;
  if (serviceTier !== "priority" && serviceTier !== "fast") {
    throw new Error('relay.serviceTier must be "priority" or "fast"');
  }
  const overwriteServiceTier = "overwriteServiceTier" in value
    ? value.overwriteServiceTier : base.overwriteServiceTier;
  if (typeof overwriteServiceTier !== "boolean") {
    throw new Error("relay.overwriteServiceTier must be a boolean");
  }
  return { mode, providers, baseURLs, models, serviceTier, overwriteServiceTier };
}

/** Only * is special. Match literal segments without regex backtracking. */
export function matchesModel(model: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => {
    const parts = pattern.split("*");
    if (parts.length === 1) return model === pattern;
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!model.startsWith(first) || !model.endsWith(last)) return false;
    let cursor = first.length;
    const end = model.length - last.length;
    for (const part of parts.slice(1, -1)) {
      const position = model.indexOf(part, cursor);
      if (position === -1) return false;
      cursor = position + part.length;
      if (cursor > end) return false;
    }
    return cursor <= end;
  });
}

export type RelayModel = { provider: string; id: string; api: string; baseUrl: string };
export type RelayMatch = { targeted: boolean; eligible: boolean; reason?: string };

/** Identity alone does not make an endpoint official. Compare parsed origins. */
export function isOfficialOpenAIRoute(model: RelayModel): boolean {
  try {
    const url = new URL(model.baseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    if (model.provider === "openai") {
      return url.origin === "https://api.openai.com" || url.origin === "https://chatgpt.com";
    }
    return model.provider === "openai-codex" && url.origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

export function matchRelay(model: RelayModel, config: RelayConfig): RelayMatch {
  // Official rules cannot be bypassed by a permissive relay model filter or list.
  if (isOfficialOpenAIRoute(model)) return { targeted: false, eligible: false };
  const baseURL = normalizeBaseURL(model.baseUrl);
  const selected = config.mode === "auto" || config.providers.includes(model.provider) ||
    (baseURL !== undefined && config.baseURLs.some((url) => normalizeBaseURL(url) === baseURL));
  // Consume unofficial OpenAI identities even when excluded, preventing fallback
  // to the official tier/auth rules for an overridden endpoint.
  const targeted = model.provider === "openai" || model.provider === "openai-codex" ||
    (selected && (RELAY_APIS.has(model.api) || config.mode === "allowlist"));
  if (!targeted) return { targeted: false, eligible: false };
  if (!selected) return { targeted: true, eligible: false, reason: "relay is not selected by the allowlist" };
  if (baseURL === undefined) {
    return { targeted: true, eligible: false, reason: "relay requires a valid HTTP(S) base URL without credentials, query or fragment" };
  }
  if (!RELAY_APIS.has(model.api)) {
    return { targeted: true, eligible: false, reason: `relay API ${model.api} is not an OpenAI-compatible Responses or Chat Completions API` };
  }
  if (!matchesModel(model.id, config.models)) {
    return { targeted: true, eligible: false, reason: "model does not match relay.models" };
  }
  return { targeted: true, eligible: true };
}
