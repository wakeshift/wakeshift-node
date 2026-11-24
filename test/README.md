# Shared SDK fixtures

The JSON files here are the contract the three SDKs share: TypeScript (`sdk/typescript`), Python (`sdk/python`) and Go (`pkg/wakeshift`). Each SDK's tests read them from this directory; each published SDK repository carries a copy (`tests/golden` in Python's, `testdata/golden` in Go's).

How each SDK loads them:

- TypeScript: `readFileSync(new URL("../../test/<file>", import.meta.url))` from the built tests (`build-test/test/*.test.js`), or `goldenFile("<file>")` in `events.test.ts`.
- Python: `golden_file("<file>")` from `sdk/python/tests/helpers.py`.
- Go: `readSharedFixture(t, "<file>", &v)`, `sharedGolden("<file>")` or `golden(t, "<file>", got)`, all resolving `goldenDir` (`../../sdk/typescript/test`, or `testdata/golden` in the published copy).

## Conventions

- **Top-level keys that start with `_`** are comments and metadata (`_about`, `_comment`, `_status`, …). Loaders ignore them; a test that compares a whole file drops them first. A few older files use a plain `comment` key the same way.
- **`skip`**: a case with `"skip": {"<language>": "why"}` doesn't run in that language (`typescript`, `python`, `go`). Every other case runs; an SDK fails on an `op` its tests don't know.
- **`op`**: a stable name for a scenario, which each SDK's test maps to code. Never match on `name`; it's for people.
- **Errors**: `"error": "<code>"` means the call throws (Go: returns) the class `errors.json` `codes` lists for that code before sending (usually `UsageError`), with that code. `says` is a substring the message must contain; `must_not_contain` lists strings it must not.
- **Shape normalization** (`events-list.json`, `subscribing-tools-list.json`): a JSON Schema is compared as `{ type, properties: { <name>: { type, description, enum } }, required }`, keeping only those keys where present, `properties` left out when it has none, `required` sorted and left out when empty. The rest (`$schema`, `additionalProperties`, how an MCP SDK spells "any object") is each MCP SDK's own rendering. Output schemas in `tool-output-schemas.json` are compared exactly.
- **Per-language option names**: fixtures use snake_case, language-neutral names (`max_retries`, `builtin_tools`, `replay_seconds`); each file's comment maps them to `maxRetries`, `builtin_tools=`, `WithMaxRetries` and so on.
- **Generated strings**: `compact_strings` in `subscribing-tools-list.json` is the one place the compact `tools/list` strings live; every literal that uses them is generated from it (`wake-args.json` `compact`, `subscribes.json` `compact_cases`, `event-tools.json`, `events-list.json` `tools`, `subscribing-tools-list.json` scenarios and `tool-output-schemas.json`).
- **Test values are fake.** The app key is `app-keys.json`'s S key; session keys, tokens and secrets are made up. Never put a real credential here: the directory is public.

## The files

| File | What it pins | Schema |
| --- | --- | --- |
| `agent-ids.json` | How a client name becomes an agent ID | `{ "<client name>": "<agent id>" }` |
| `app-keys.json` | Key parsing: seeds, accepted and refused keys | `seeds[]`, `accepted[] { key, seed, mode, app_id }`, `refused[] { key, why }` |
| `arg-values.json` | Encoding and decoding argument values | `encode[]`, `encode_round_trip`, `refused_encode[]`, `decode[]`, `refused_decode[]` |
| `client-requests.json` | The requests the SDK makes of the MCP client during a subscribing call | see its `_about` |
| `conversation-meta.json` | The `_meta` keys that carry a conversation ID | `keys[]` |
| `default-text.json` | The line an agent reads for an event without `text`: description, then sorted arguments | `cases[] { name, description, args, want }` |
| `disabled-client.json` | A client without a key: construction, option checks, and each method | `construction.cases[]`, `option_checks.cases[]`, `methods.cases[]` |
| `emit-recipients.json` | Emit recipients on the wire | see its `comment` |
| `errors.json` | Retries, the error each answer becomes, JSON-RPC errors, client checks, every code and the messages the SDK writes itself | `codes[]`, `messages`, `client_checks`, `client_checks_next` |
| `event-tools.json` | The built-in tools' wording | `{ "<key>": "<text with {placeholders}>" }`, compared whole; Go writes it |
| `events-list.json` | `events/list`, `tools/list` (shape-normalized) and the manifest for three sample events | `{ events[], manifest[], tools[] }`, compared whole; Go writes it |
| `manifest.json` | The manifest every SDK sends, and when | see its `_comment` |
| `mcp-events-clients.json` | The MCP Events client table, the one source of truth (not a test file): the clients that are exceptions to capability negotiation and the dialect each needs. The core embeds a copy; the TypeScript and Python SDKs ship it as generated constants (`go run ./internal/mcpevents/clientsgen/gen`); a test in each fails when a copy drifts. Its cases are `mcp-events-interop.json` `native_client` | `_about` (the match semantics), `schema`, `dialects`, `entries[] { id, match, without_push?, native, dialect, reason, source }` |
| `mcp-events-interop.json` | `Mcp-Name` (decoding; a mismatch refused, a missing one accepted), `events/stream`'s refusal, `-32601` with no events, the native-client rule and the client table's cases | each section's `_comment` |
| `mcp-events-wire.json` | The MCP Events wire format, including `next` (the checks on `events/subscribe` and `events/poll`, refusals, the built-in calls, `call.subscribe`'s result per access setting) and `push` (`events/stream`) | each section's `_comment` |
| `mcp-tasks-wire.json` | The wait tool's tasks wire format | see its `comment` |
| `secret-pattern.json` | What `redactSecrets` removes | `rules`, `reference_pattern`, `vectors[] { name, input, want }` |
| `skip-wait.json` | When a tool can skip its own wait | `about`, `cases[]` |
| `subscribe-options.json` | `replay` and `once` on the wire, their bounds and duration strings | `replay_bounds[]`, `duration_strings[]` |
| `subscribes.json` | The subscribes sentence | `cases[] { name, description, app, events[], want }`, `compact_cases` |
| `subscribing-tools-list.json` | What `tools/list` serves for tools that subscribe, through `registerTool`/`@tool`/`AddTool` and through `wrap` | `compact_strings`, `app`, `events`, `vendor_tools`, `scenarios[]` |
| `tool-annotations.json` | The built-in tools' annotations | `{ "<tool>": { …annotations } }`; Go writes it |
| `tool-output-schemas.json` | The built-in tools' output schemas | `{ "<tool>": <JSON Schema> }`, compared exactly; Go writes it |
| `wake-args.json` | Wakeshift's three tool arguments | `properties`, `compact { subscribing, subscribes_nothing }` |
| `warnings.json` | The SDKs' log lines: levels, fields, policies, codes, and the lines each situation logs | `levels`, `fields`, `policies`, `codes[]`, `situations.cases[]` |
| `watch.json` | `event.watch` (the poll-then-emit-once helper) and an event's `onSubscribe`: delays, option checks, outcomes, when `onSubscribe` runs | `defaults`, `delays.cases[]`, `option_checks.cases[]`, `outcomes.cases[]`, `on_subscribe.cases[]` |
| `wrapped-block.json` | The block a tool that subscribes adds to its result | see its `comment` |
