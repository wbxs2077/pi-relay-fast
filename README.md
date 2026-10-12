# pi-relay-fast

[简体中文](README.zh-CN.md)

Fast mode for [Pi](https://pi.dev), including third-party OpenAI-compatible
relays. Run `/fast on` to request `service_tier: "priority"` for matching relay
models through Pi's native request hook.

**Release status:** `0.1.0` is prepared for the first independent release. This
checkout has not been published to npm; use the local installation below.

## Features

- Automatically supports `openai-responses` and `openai-completions` relays.
- Matches `gpt-*` by default; supports custom model globs and optional allowlists.
- Requests `priority` by default, or `fast` when configured.
- Preserves existing tiers unless relay overwrite is explicitly enabled.
- Provides local commands, session-only state, and injection/skip diagnostics.
- Retains pi-fast's official OpenAI, Codex, Anthropic, and restricted Ultrafast paths.

Fast defaults **off**. Injection shows that a field was added to the request; it
does not prove that the relay forwarded it or that the upstream applied a faster
tier. Availability and billing depend on your provider.

## Requirements

- Node.js **22.19.0 or newer**.
- Pi with native provider request/header hooks; compatibility is tested against
  `@earendil-works/pi-coding-agent` **1.1.0**.
- A working Pi model/provider configuration. This extension does not configure
  your relay connection or credentials.

The host peer dependency uses `*` as required by Pi's package convention. It is
not a claim of compatibility with every Pi version; 1.1.0 is the tested baseline.

## Install

Clone the repository and install from its root:

```sh
git clone https://github.com/wbxs2077/pi-relay-fast.git
cd pi-relay-fast
pi install .
```

Pi references the local directory without copying it, so keep the checkout in
place. No compilation or development dependency installation is needed to use
it in Pi. In an already-running Pi session:

```text
/reload
/fast on
/fast status
```

Avoid loading upstream `pi-fast`, a collection copy of it, or another extension
registering `/fast` at the same time. Disable/remove the overlapping extension.

To remove a local install, run `pi remove .` from the same checkout, then `/reload`.
Your `fast.json` settings are not deleted by that command.

## Configure

No Fast configuration is required for automatic matching. Optionally merge
[examples/fast.json](examples/fast.json) into:

- Global: `~/.pi/agent/extensions/fast.json`.
- Project: the nearest `.pi/fast.json` in the current directory or its ancestors,
  read only after Pi trusts the project. Review it before trusting the project.

If Pi uses a custom agent/config directory, use its corresponding location.
Restart or `/reload` after editing.

```json
{
  "enabled": false,
  "showStatus": true,
  "relay": {
    "mode": "auto",
    "models": ["gpt-*"],
    "serviceTier": "priority",
    "overwriteServiceTier": false
  }
}
```

For explicit targeting, see [the allowlist example](examples/fast.allowlist.json).
For a generic Pi connection example using an environment variable, see
[examples/models.json](examples/models.json). Replace its example URL and model;
merge it into your Pi `models.json` separately from `fast.json`.

Load order is defaults, global, then trusted project settings. Fields merge;
arrays replace inherited arrays. Invalid JSON, unknown fields, or wrong types
disable injection, even after `/fast on`.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Fast default at session start |
| `showStatus` | `true` | Show a footer indicator while active |
| `relay.mode` | `"auto"` | `auto` matches compatible relays; `allowlist` limits targets |
| `relay.models` | `["gpt-*"]` | Case-sensitive patterns; only `*` is special; `[]` matches all |
| `relay.serviceTier` | `"priority"` | Requested relay tier: `priority` or `fast` |
| `relay.overwriteServiceTier` | `false` | Replace existing relay tiers only when true |
| `relay.providers` | `[]` | Exact provider IDs for allowlist mode |
| `relay.baseURLs` | `[]` | Additional base URL targets for allowlist mode |

In `auto`, target lists are ignored. In `allowlist`, either a provider or URL
must match; empty lists select nothing. Supplying either target list without
`mode` selects `allowlist` for that config layer. Model/API filters still apply.
URLs must be HTTP(S), without credentials, query, or fragment; matching uses the
full normalized origin and path, ignoring trailing slashes, not URL prefixes.

## Commands

| Command | Behavior |
| --- | --- |
| `/fast`, `/fast toggle` | Toggle ordinary Fast; if Ultrafast is selected, turn it off |
| `/fast on` | Enable ordinary Fast and exit Ultrafast |
| `/fast off` | Stop this extension's Fast and Ultrafast injection |
| `/fast status` | Show eligibility, filtering, tier, overwrite policy, count, and last result |
| `/ultrafast`, `/fast ultrafast` | Toggle the inherited, restricted official Ultrafast path |

Commands run locally without a model call. The ordinary Fast switch follows
model changes in the same session, but only matching requests are changed.
Restart/reload resets the switch and counters to the config default. `/fast off`
does not remove a tier already provided by another extension or model setting.

## Troubleshooting and limits

- **Inactive:** check API type, model glob, and allowlist mode in `/fast status`.
  Prefixed model IDs such as `openai/gpt-6-astra` need a pattern like `*/gpt-*`.
- **Existing tier preserved:** set `overwriteServiceTier: true` only if you want
  this extension to replace tiers on relay requests.
- **Configuration error:** use valid JSON and supported fields, then `/reload`.
  Invalid config disables injection even after `/fast on`.
- **Relay rejects the field:** turn Fast off or exclude the model. This extension
  does not silently retry without the field or downgrade the requested tier.
- **Count increased but no speed change:** the count measures payload changes,
  not accepted tiers, successful responses, or HTTP retries.
- **Official routes:** built-in model/API restrictions apply; official Codex
  requires OAuth. Relay configuration cannot bypass official restrictions or
  overwrite official tiers. OpenAI provider IDs using third-party endpoints
  follow relay rules, including exclusions.
- **Ultrafast:** requires `openai`, `openai-responses`, `gpt-6-astra`, API-key auth,
  and exactly `https://api.openai.com/v1` (one trailing slash allowed). Config
  cannot enable it. Switching to an unsupported model/endpoint turns both modes
  off until manually enabled. Pi's cost display may omit tier premiums.

Third-party Anthropic, Azure/Gemini APIs, Codex-specific relay authentication,
and relay Ultrafast are outside this extension's relay support. Request bodies,
credentials, and complete URLs are not logged by the extension.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

The public check runs TypeScript checking and a package dry run; `npm pack` runs
the same checks before packing. It does not call model services. Report bugs via
[Issues](https://github.com/wbxs2077/pi-relay-fast/issues), with credentials and
private configuration removed. For vulnerabilities, request a private contact
channel without posting exploit details publicly.

## Credits and license

Derived from [Diego Petrucci's pi-fast](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/fast).
Relay support is inspired by [wbxs2077/opencode-relay-fast](https://github.com/wbxs2077/opencode-relay-fast).
This implementation uses Pi-native hooks and does not wrap global fetch.

[MIT](LICENSE). Upstream copyright is retained; see [NOTICE](NOTICE).
