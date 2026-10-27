import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Pi's TypeScript loader registers the extension, commands and native hooks", async () => {
  const loaderURL = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { loadExtensions } = await import(loaderURL.href);
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Unexpected network call during extension loading"); };
  try {
    // Load only this extension. Do not discover user extensions or start a session.
    const result = await loadExtensions([entry], cwd);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.deepEqual([...extension.commands.keys()].sort(), ["fast", "ultrafast"]);
    for (const event of ["session_start", "model_select", "before_provider_request", "before_provider_headers"]) {
      assert.equal(extension.handlers.get(event)?.length, 1, event);
    }
    assert.deepEqual(extension.commands.get("fast").getArgumentCompletions("st"), [
      { value: "status", label: "status" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
