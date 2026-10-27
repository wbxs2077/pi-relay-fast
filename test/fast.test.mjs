import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";

// Isolate extension tests from the operator's Pi installation and real secrets.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return {
        url: "data:text/javascript," + encodeURIComponent(`
          export const CONFIG_DIR_NAME = '.pi';
          export function getAgentDir() { return globalThis.__fastTestAgentDir; }
        `),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { default: extension } = await import("../index.ts");
hook.deregister();
const { mergeRelayConfig, DEFAULT_RELAY_CONFIG, matchesModel, normalizeBaseURL, matchRelay } = await import("../relay.ts");
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  delete globalThis.__fastTestAgentDir;
});

function harness(config = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project", "nested");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const globalConfig = join(agentDir, "extensions", "fast.json");
  writeFileSync(globalConfig, typeof config === "string" ? config : JSON.stringify(config));
  if (options.projectConfig !== undefined) {
    const projectDir = join(root, "project", ".pi");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "fast.json"), typeof options.projectConfig === "string"
      ? options.projectConfig : JSON.stringify(options.projectConfig));
  }
  globalThis.__fastTestAgentDir = agentDir;
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const statuses = new Map();
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => options.trusted ?? false,
    sessionManager: {},
    model: {
      id: "gpt-6-astra", provider: "relay-a", api: "openai-responses",
      baseUrl: "https://relay.example/v1", ...options.model,
    },
    modelRegistry: {
      isUsingOAuth: () => options.oauth ?? false,
      getProviderAuth: async () => undefined,
    },
    ui: {
      notify: (text, level) => notices.push({ text, level }),
      setStatus: (key, value) => statuses.set(key, value),
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => [],
  };
  extension(pi);
  const start = () => {
    globalThis.__fastTestAgentDir = agentDir;
    handlers.get("session_start")({}, ctx);
  };
  start();
  return {
    ctx, handlers, commands, statuses, notices, globalConfig, start,
    request: (payload = { model: ctx.model.id, input: "test" }) =>
      handlers.get("before_provider_request")({ payload }, ctx),
    headers: async (headers = {}) => {
      await handlers.get("before_provider_headers")({ headers }, ctx);
      return headers;
    },
    command: (args, name = "fast") => commands.get(name).handler(args, ctx),
    status: async () => {
      await commands.get("fast").handler("status", ctx);
      return notices.at(-1).text;
    },
  };
}
const relay = { providers: ["relay-a", "relay-b", "relay-c"], models: ["gpt-*"] };

test("default off; /fast on automatically supports GPT relays without configuration", async () => {
  const h = harness();
  assert.equal(h.request(), undefined);
  await h.command("on");
  assert.equal(h.request().service_tier, "priority");
  assert.match(await h.status(), /\(relay\)/);
});

for (const provider of relay.providers) {
  for (const api of ["openai-responses", "openai-completions"]) {
    test(`explicit relay ${provider} / ${api} accepts API-key auth`, async () => {
      const h = harness({ relay }, { model: { provider, api } });
      assert.equal(h.request(), undefined);
      await h.command("on");
      const payload = { model: h.ctx.model.id, input: [{ text: "private message" }], stream: true };
      const next = h.request(payload);
      assert.deepEqual(next, { ...payload, service_tier: "priority" });
      assert.equal(payload.service_tier, undefined);
      assert.equal(next.input, payload.input);
      assert.deepEqual(await h.headers({ Authorization: "unchanged" }), { Authorization: "unchanged" });
      assert.match(await h.status(), /Injected requests: 1/);
      assert.match(await h.status(), /\(relay\)/);
      assert.doesNotMatch(await h.status(), /private message|Authorization/);
      await h.command("off");
      assert.equal(h.request(), undefined);
      assert.equal(h.statuses.get("fast"), undefined);
    });
  }
}

test("on/off/status are idempotent; toggle and invalid command semantics", async () => {
  const h = harness({ relay });
  await h.command(" ON ");
  await h.command("on");
  assert.equal(h.request().service_tier, "priority");
  await h.status();
  assert.equal(h.request().service_tier, "priority");
  await h.command("toggle");
  assert.equal(h.request(), undefined);
  await h.command("");
  await h.command("unknown");
  assert.match(h.notices.at(-1).text, /Usage/);
  assert.equal(h.request().service_tier, "priority");
  await h.command("off");
  await h.command("off");
  assert.equal(h.request(), undefined);
});

test("provider allowlist isolates two providers sharing the same base URL", () => {
  const h = harness({ enabled: true, relay });
  assert.equal(h.request().service_tier, "priority");
  h.ctx.model.provider = "unselected";
  h.handlers.get("model_select")({}, h.ctx);
  assert.equal(h.request(), undefined);
  assert.equal(h.statuses.get("fast"), undefined);
  h.ctx.model.provider = "relay-b";
  assert.equal(h.request().service_tier, "priority");
});

test("baseURL opt-in is exact and independent of provider ID", () => {
  const h = harness({ enabled: true, relay: { baseURLs: ["https://RELAY.example/v1/"] } });
  assert.equal(h.request().service_tier, "priority");
  for (const baseUrl of ["https://relay.example/v10", "https://relay.example.evil/v1", "https://relay.example/v1/other", "http://relay.example/v1", "https://relay.example/v1?api_key=secret", "https://u:p@relay.example/v1"]) {
    h.ctx.model.baseUrl = baseUrl;
    assert.equal(h.request(), undefined, baseUrl);
  }
});

test("relay API and model exclusions fail closed, even for an official provider ID", () => {
  const h = harness({ enabled: true, relay: { providers: ["openai"], models: ["gpt-5.*"] } }, {
    model: { provider: "openai" },
  });
  assert.equal(h.request(), undefined);
  h.ctx.model.id = "gpt-5.5";
  assert.equal(h.request().service_tier, "priority");
  h.ctx.model.api = "anthropic-messages";
  assert.equal(h.request(), undefined);
});

test("unsupported provider and non-OpenAI models do not get injected", () => {
  const h = harness({ enabled: true, relay });
  h.ctx.model.id = "claude-opus-5";
  assert.equal(h.request(), undefined);
  h.ctx.model.id = "gpt-6-astra";
  for (const api of ["anthropic-messages", "google-generative-ai", "azure-openai-responses", "openai-codex-responses"]) {
    h.ctx.model.api = api;
    assert.equal(h.request(), undefined);
  }
});

test("existing tiers are preserved by default, including null and falsy values", async () => {
  const h = harness({ enabled: true, relay });
  for (const service_tier of ["default", "priority", "fast", "flex", null, undefined, ""]) {
    const payload = { model: h.ctx.model.id, service_tier };
    assert.equal(h.request(payload), undefined);
    assert.equal(payload.service_tier, service_tier);
  }
  assert.match(await h.status(), /Injected requests: 0/);
  assert.match(await h.status(), /existing service_tier preserved/);
});

test("explicit overwrite follows reference behavior only on relay routes", () => {
  const h = harness({ enabled: true, relay: { ...relay, overwriteServiceTier: true, serviceTier: "fast" } });
  assert.equal(h.request({ model: h.ctx.model.id, service_tier: "default" }).service_tier, "fast");
  assert.equal(h.request({ model: h.ctx.model.id, service_tier: "fast" }), undefined);
  h.ctx.model.provider = "openai";
  h.ctx.model.baseUrl = "https://api.openai.com/v1";
  assert.equal(h.request({ model: h.ctx.model.id, service_tier: "default" }), undefined);
});

test("malformed payload, wrong model and no model are untouched", () => {
  const h = harness({ enabled: true, relay });
  for (const payload of [null, 1, "json", [], {}, { model: "other" }]) {
    assert.equal(h.request(payload), undefined);
  }
  h.ctx.model = undefined;
  assert.equal(h.request({ model: "gpt-6-astra" }), undefined);
});

for (const invalid of [
  "{ not-json", "null", "[]", '{"enabled":"yes"}', '{"enabled":true,"relay":null}',
  { enabled: true, relay: { providers: "relay-a" } },
  { enabled: true, relay: { mode: "invalid" } },
  { enabled: true, relay: { providers: ["relay-a"], models: "gpt-*" } },
  { enabled: true, relay: { providers: ["relay-a"], baseURLs: ["javascript:alert(1)"] } },
  { enabled: true, relay: { providers: ["relay-a"], serviceTier: "ultrafast" } },
  { enabled: true, relay: { providers: ["relay-a"], overwriteServiceTier: "yes" } },
  { enabled: true, relay: { providers: ["relay-a"], model: ["gpt-*"] } },
  { enabled: true, relays: relay },
]) {
  test(`invalid config blocks /fast on and ultrafast: ${JSON.stringify(invalid)}`, async () => {
    const h = harness(invalid, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" } });
    await h.command("on");
    assert.equal(h.request(), undefined);
    await h.command("ultrafast");
    assert.equal(h.request(), undefined);
    assert.match(await h.status(), /configuration error/);
  });
}

test("project config ignored without trust; nearest ancestor overrides with trust", () => {
  const options = { projectConfig: { relay: { models: ["gpt-5.*"], serviceTier: "fast" } } };
  const untrusted = harness({ enabled: true, relay }, options);
  assert.equal(untrusted.request().service_tier, "priority");
  const trusted = harness({ enabled: true, relay }, { ...options, trusted: true });
  assert.equal(trusted.request(), undefined);
  trusted.ctx.model.id = "gpt-5.5";
  assert.equal(trusted.request().service_tier, "fast");
});

test("trusted project config search stops before the home directory", () => {
  const h = harness({ enabled: true, relay }, { trusted: true });
  const root = dirname(dirname(h.ctx.cwd));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "fast.json"), JSON.stringify({ enabled: false }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = process.env.USERPROFILE = root;
    h.start();
    assert.equal(h.request().service_tier, "priority");
    process.env.HOME = process.env.USERPROFILE = join(root, "elsewhere");
    h.start();
    assert.equal(h.request(), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("invalid trusted project config cannot fall back to enabled global config", async () => {
  const h = harness({ enabled: true, relay }, { projectConfig: "{", trusted: true });
  await h.command("on");
  assert.equal(h.request(), undefined);
  assert.match(await h.status(), /configuration error/);
});

test("empty arrays clear inherited targets", () => {
  const h = harness({ enabled: true, relay }, {
    projectConfig: { relay: { providers: [], baseURLs: [] } }, trusted: true,
  });
  assert.equal(h.request(), undefined);
});

test("restart/reload resets session toggle and counters, config defaults remain", async () => {
  const h = harness({ relay });
  await h.command("on");
  h.request();
  h.start();
  assert.equal(h.request(), undefined);
  assert.match(await h.status(), /Injected requests: 0/);
  writeFileSync(h.globalConfig, JSON.stringify({ enabled: true, relay }));
  h.start();
  assert.equal(h.request().service_tier, "priority");
});

test("sessions are isolated within one extension runtime", async () => {
  const h = harness({ relay });
  const second = { ...h.ctx, sessionManager: {} };
  h.handlers.get("session_start")({}, second);
  await h.command("on");
  assert.equal(h.request().service_tier, "priority");
  assert.equal(h.handlers.get("before_provider_request")({ payload: { model: second.model.id } }, second), undefined);
});

test("headless injection and showStatus=false do not require a terminal", () => {
  const h = harness({ enabled: true, showStatus: false, relay }, { hasUI: false });
  h.ctx.ui = new Proxy({}, { get() { throw new Error("UI should not be accessed"); } });
  assert.equal(h.request().service_tier, "priority");
});

test("official OpenAI and Codex eligibility and fields remain unchanged", () => {
  const direct = harness({ enabled: true }, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" } });
  assert.equal(direct.request().service_tier, "fast");
  direct.ctx.model.id = "unknown";
  assert.equal(direct.request(), undefined);
  const codex = harness({ enabled: true }, { model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5", baseUrl: "https://chatgpt.com/backend-api" }, oauth: true });
  assert.equal(codex.request().service_tier, "priority");
  codex.ctx.modelRegistry.isUsingOAuth = () => false;
  assert.equal(codex.request(), undefined);
});

test("third-party Anthropic endpoints get neither speed nor the Fast beta header", async () => {
  const h = harness({ enabled: true }, {
    model: { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5", baseUrl: "https://api.anthropic.com/" },
  });
  assert.equal(h.request().speed, "fast");
  for (const baseUrl of ["https://anthropic-relay.example/v1", "https://api.anthropic.com.evil", "http://api.anthropic.com", "https://u:p@api.anthropic.com", "invalid"]) {
    h.ctx.model.baseUrl = baseUrl;
    assert.equal(h.request(), undefined, baseUrl);
    assert.deepEqual(await h.headers({ "anthropic-beta": "existing" }), { "anthropic-beta": "existing" }, baseUrl);
  }
  assert.match(await h.status(), /requires the official endpoint https:\/\/api\.anthropic\.com/);
});

test("official Anthropic speed and beta headers preserved without model mutation", async () => {
  const h = harness({ enabled: true }, {
    model: {
      provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5", baseUrl: "https://api.anthropic.com",
      headers: { "Anthropic-Beta": "existing-beta" },
    },
  });
  assert.equal(h.request().speed, "fast");
  const headers = await h.headers({ "anthropic-beta": "another-beta" });
  assert.match(headers["Anthropic-Beta"], /existing-beta/);
  assert.match(headers["Anthropic-Beta"], /another-beta/);
  assert.match(headers["Anthropic-Beta"], /fast-mode-2026-02-01/);
  assert.equal(h.ctx.model.headers["Anthropic-Beta"], "existing-beta");
  assert.equal(h.request({ model: h.ctx.model.id, speed: "standard" }), undefined);
  await h.command("off");
  assert.deepEqual(await h.headers(), {});
});

test("Ultrafast stays official-only, session-only and disables on switching to relay", async () => {
  const h = harness({ relay }, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" } });
  await h.command("ultrafast");
  assert.equal(h.request().service_tier, "ultrafast");
  h.ctx.model.provider = "relay-a";
  h.ctx.model.baseUrl = "https://relay.example/v1";
  h.handlers.get("model_select")({}, h.ctx);
  assert.equal(h.request(), undefined);
  await h.command("ultrafast");
  assert.equal(h.request(), undefined);
  await h.command("on");
  assert.equal(h.request().service_tier, "priority");
});

test("model globs treat punctuation literally; empty list means all models", () => {
  assert.equal(matchesModel("gpt-6.astra", ["gpt-6.astra"]), true);
  assert.equal(matchesModel("gpt-6Xastra", ["gpt-6.astra"]), false);
  assert.equal(matchesModel("x/[a]+(b)?", ["x/[a]+(b)?"]), true);
  assert.equal(matchesModel("openai/gpt-6-astra", ["gpt-*"]), false);
  assert.equal(matchesModel("openai/gpt-6-astra", ["*/gpt-*"]), true);
  assert.equal(matchesModel("anything", []), true);
});

test("model globs match the whole ID and do not overlap literal segments", () => {
  assert.equal(matchesModel("gpt-6\n", ["gpt-6"]), false);
  assert.equal(matchesModel("ab", ["ab*ab"]), false);
  assert.equal(matchesModel("abc", ["a*bc*c"]), false);
  assert.equal(matchesModel("abcabc", ["a*bc*abc"]), true);
  assert.equal(matchesModel("gpt-6-astra", ["**gpt**6***astra**"]), true);
  assert.equal(matchesModel("", ["*"]), true);
  assert.equal(matchesModel("", ["gpt-*"]), false);
});

test("many wildcard segments cannot stall model selection", () => {
  // A process timeout can interrupt a synchronous regression; a test timeout cannot.
  const source = `
    import assert from 'node:assert/strict';
    import { matchesModel } from ${JSON.stringify(new URL("../relay.ts", import.meta.url).href)};
    assert.equal(matchesModel('a'.repeat(80), ['*a'.repeat(30) + 'b']), false);
    assert.equal(matchesModel('a'.repeat(80) + 'c', ['*a'.repeat(100) + '*c']), false);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("official provider IDs cannot bypass invalid endpoint checks", () => {
  for (const provider of ["openai", "openai-codex"]) {
    const h = harness({ enabled: true }, { oauth: true, model: {
      provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
    } });
    for (const origin of ["https://api.openai.com", "https://chatgpt.com"]) {
      for (const suffix of ["?key=secret", "#fragment"]) {
        h.ctx.model.baseUrl = `${origin}/v1${suffix}`;
        assert.equal(h.request(), undefined);
      }
    }
  }
});

// Exercise the real Pi 1.1.0 serializers and OpenAI SDK, using ONLY fake fetch.
// This verifies service_tier reaches the serialized HTTP body (not just a mock hook).
for (const api of ["openai-responses", "openai-completions"]) {
 for (const mode of ["auto", "allowlist"]) {
  test(`wire serialization through Pi ${api} / ${mode}, with zero network calls`, async () => {
    const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
    const h = harness({ relay: { ...relay, mode } }, { model: { api } });
    const model = Object.assign(h.ctx.model, {
      type: "chat", name: "Test", reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const captured = [];
    const originalFetch = globalThis.fetch;
    // If the real provider ignores our fake fetch, fail rather than access the network.
    globalThis.fetch = () => { throw new Error("Unexpected network call"); };
    const fakeFetch = async (input, init) => {
      const request = new Request(input, init);
      captured.push({
        url: request.url, headers: request.headers,
        body: JSON.parse(await request.text()), method: request.method,
      });
      const event = api === "openai-responses" ? {
        type: "response.completed",
        response: { id: "resp_test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 } },
      } : {
        id: "chat_test", object: "chat.completion.chunk", model: model.id,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { "Content-Type": "text/event-stream" },
      });
    };
    const send = async () => {
      const result = await streamSimple(model, {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      }, {
        apiKey: "sk-test-not-a-real-key", fetch: fakeFetch, maxRetries: 0,
        onPayload: (payload) => h.request(payload),
        headers: { "x-test": "preserved" },
      }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
    };
    try {
      await send();
      await h.command("on");
      await send();
      await h.command("off");
      await send();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(captured.length, 3);
    assert.equal(captured[0].body.service_tier, undefined);
    assert.equal(captured[1].body.service_tier, "priority");
    assert.equal(captured[2].body.service_tier, undefined);
    assert.equal(captured[1].body.model, model.id);
    assert.equal(captured[1].headers.get("authorization"), "Bearer sk-test-not-a-real-key");
    assert.equal(captured[1].headers.get("x-test"), "preserved");
    assert.equal(captured[1].method, "POST");
    assert.equal(captured[1].url, `https://relay.example/v1/${api === "openai-responses" ? "responses" : "chat/completions"}`);
    assert.deepEqual(captured[1].body, { ...captured[0].body, service_tier: "priority" });
  });
 }
}

test("automatic mode filters models, supports aliases and follows provider changes", async () => {
  const h = harness({ enabled: true });
  for (const provider of ["relay-a", "relay-b", "relay-c", "new-relay"]) {
    for (const api of ["openai-responses", "openai-completions"]) {
      Object.assign(h.ctx.model, { provider, api });
      assert.equal(h.request().service_tier, "priority");
    }
  }
  for (const id of ["deepseek-v4", "glm-5", "kimi-k3", "openai/gpt-6-astra"]) {
    h.ctx.model.id = id;
    assert.equal(h.request(), undefined);
  }
  assert.match(await h.status(), /model does not match relay.models/);
  const aliases = harness({ enabled: true, relay: { models: ["*/gpt-*"], serviceTier: "fast" } }, {
    model: { id: "openai/gpt-6-astra" },
  });
  assert.equal(aliases.request().service_tier, "fast");
  const all = harness({ enabled: true, relay: { models: [] } }, { model: { id: "custom-alias" } });
  assert.equal(all.request().service_tier, "priority");
});

test("official identities with third-party endpoints obey relay rules, including exclusions", () => {
  for (const provider of ["openai", "openai-codex"]) {
    const h = harness({ enabled: true }, { model: { provider, id: "gpt-5.5" } });
    assert.equal(h.request().service_tier, "priority");
    h.ctx.model.id = "claude-opus-5";
    assert.equal(h.request(), undefined);
    h.ctx.model.api = "openai-codex-responses";
    h.ctx.model.id = "gpt-6-astra";
    h.ctx.modelRegistry.isUsingOAuth = () => true;
    assert.equal(h.request(), undefined);
    const excluded = harness({ enabled: true, relay: { mode: "allowlist" } }, { model: { provider } });
    assert.equal(excluded.request(), undefined);
  }
});

test("official endpoint detection uses exact HTTPS origins and cannot bypass official model rules", () => {
  const h = harness({ enabled: true, relay: { models: [], providers: ["openai"], overwriteServiceTier: true } }, {
    model: { provider: "openai", baseUrl: "https://API.OPENAI.COM:443/v1/" },
  });
  assert.equal(h.request().service_tier, "fast");
  assert.equal(h.request({ model: h.ctx.model.id, service_tier: "default" }), undefined);
  h.ctx.model.id = "gpt-future";
  assert.equal(h.request(), undefined);
  h.ctx.model.id = "gpt-6-astra";
  for (const baseUrl of ["https://api.openai.com.evil/v1", "http://api.openai.com/v1", "https://api.openai.com:8443/v1", "https://relay.example/api.openai.com/v1"]) {
    h.ctx.model.baseUrl = baseUrl;
    assert.equal(h.request().service_tier, "priority");
  }
  for (const baseUrl of ["invalid", "file:///v1", "https://api.openai.com@relay.example/v1", "https://relay.example/v1?key=secret"]) {
    h.ctx.model.baseUrl = baseUrl;
    assert.equal(h.request(), undefined);
  }
});

test("official OAuth routes remain usable and auth lookup failures skip Codex", () => {
  const h = harness({ enabled: true }, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" }, oauth: true });
  assert.equal(h.request().service_tier, "fast");
  Object.assign(h.ctx.model, { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" });
  assert.equal(h.request().service_tier, "priority");
  h.ctx.modelRegistry.isUsingOAuth = () => { throw new Error("registry unavailable"); };
  assert.equal(h.request(), undefined);
});

test("legacy allowlists remain restrictive; explicit auto opts back in across config layers", () => {
  const legacy = harness({ enabled: true, relay: { providers: [] } });
  assert.equal(legacy.request(), undefined);
  const automatic = harness({ enabled: true, relay }, {
    trusted: true, projectConfig: { relay: { mode: "auto" } }, model: { provider: "new-relay" },
  });
  assert.equal(automatic.request().service_tier, "priority");
  assert.throws(() => mergeRelayConfig(DEFAULT_RELAY_CONFIG, { mode: "typo" }), /relay.mode/);
  const copy = mergeRelayConfig(DEFAULT_RELAY_CONFIG, undefined);
  copy.models.push("custom");
  assert.deepEqual(DEFAULT_RELAY_CONFIG.models, ["gpt-*"]);
});

test("Windows UTF-8 BOM configs load normally", () => {
  const h = harness('\uFEFF{"enabled":true}');
  assert.equal(h.request().service_tier, "priority");
});

test("status explains automatic filtering while off without counting or enabling requests", async () => {
  const h = harness({}, { model: { id: "glm-5", provider: "other-models" } });
  const status = await h.status();
  assert.match(status, /off \(config default\)/);
  assert.match(status, /ineligible \(model does not match relay.models\)/);
  assert.match(status, /Relay: auto; models=gpt-\*; service_tier=priority; overwrite=false/);
  assert.match(status, /Injected requests: 0/);
  h.ctx.model.id = "gpt-6-astra";
  assert.equal(h.request(), undefined);
});

test("Ultrafast reports a skipped request after an earlier injection", async () => {
  const h = harness({}, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" } });
  await h.command("ultrafast");
  assert.equal(h.request().service_tier, "ultrafast");
  assert.equal(h.request({ model: h.ctx.model.id, service_tier: "default" }), undefined);
  assert.match(await h.status(), /Injected requests: 1/);
  assert.match(await h.status(), /Last request: skipped \(existing service_tier preserved\)/);
});

test("headless Ultrafast deactivation does not access UI", async () => {
  const h = harness({}, { model: { provider: "openai", baseUrl: "https://api.openai.com/v1" } });
  await h.command("ultrafast");
  h.ctx.hasUI = false;
  h.ctx.ui = new Proxy({}, { get() { throw new Error("no UI"); } });
  h.ctx.model.baseUrl = "https://relay.example/v1";
  assert.equal(h.request(), undefined);
  assert.equal(h.request(), undefined);
});

test("relay normalization and matching do not mutate defaults or inputs", () => {
  const config = mergeRelayConfig(DEFAULT_RELAY_CONFIG, { providers: [" relay-a ", "relay-a"] });
  assert.deepEqual(config.providers, ["relay-a"]);
  assert.deepEqual(DEFAULT_RELAY_CONFIG.providers, []);
  assert.equal(normalizeBaseURL("https://EXAMPLE.COM:443/v1///"), "https://example.com/v1");
  assert.equal(normalizeBaseURL("https://example.com/v1#secret"), undefined);
  assert.equal(matchRelay({ provider: "other", id: "gpt-6-astra", api: "openai-responses", baseUrl: "bad-url" }, config).targeted, false);
});
