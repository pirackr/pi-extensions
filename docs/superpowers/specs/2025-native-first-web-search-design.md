# Native-first web search design

## Goal

Prefer official model-provider web capabilities automatically while retaining the existing `web_lookup` and `fetch_web` tools as reliable fallbacks.

## Scope

Native tools are enabled only for official providers and supported API transports:

| Provider | Native capabilities | Extension fallback |
| --- | --- | --- |
| OpenAI | Web search | `web_lookup`, `fetch_web` |
| Anthropic | Web search and web fetch | `web_lookup`, `fetch_web` |
| DeepSeek | Web search through its official supported transport | `web_lookup`, `fetch_web` |

Compatible gateways such as OpenRouter and OpenCode Zen are excluded, even if their model IDs contain OpenAI, Claude, or DeepSeek names.

## Architecture

The existing web-search extension adds provider-native server-tool definitions through Pi's `before_provider_request` hook. Capability detection uses the active model's provider, model ID/API protocol, and effective official endpoint. It must not rely on model-name matching alone.

The model receives native capabilities on every supported request and decides whether they are needed. Existing client tools remain active. Prompt guidance establishes the routing policy:

1. Prefer provider-native web search and fetch.
2. If a native operation fails, returns no useful results, or lacks URL-fetch support, call `web_lookup` or `fetch_web`.
3. Use extension tools directly for unsupported providers.

Native fallback is model-driven through Pi's normal agent loop; it is not a transparent retry inside `web_lookup`.

## Zero-configuration behavior

No user configuration or migration is required. Provider capability mappings, conservative usage limits, and tool versions are packaged in code and updated with the package.

Unsupported models and providers retain current behavior. A compact status indicator may show `web: native+fallback` for supported official models and `web: extension` otherwise.

## Payload safety

Each adapter must:

- inject the provider's exact native tool shape;
- preserve existing client tools;
- avoid duplicate native definitions;
- leave unsupported payloads untouched;
- use conservative built-in limits;
- preserve native citations, encrypted provider result data, and server-tool blocks across turns.

If Pi's response parser cannot safely preserve a provider's native result blocks, that provider must remain disabled rather than silently losing citations or replay data. The long-term remedy is upstream support in `pi-ai`, not a partial custom stream implementation in this package.

## Failure handling

Native tool failures may be represented inside otherwise successful provider responses. Prompt guidance tells the model to use extension fallback after such failures. Invalid injected payloads must fail visibly and must not silently degrade into an ungrounded answer.

## Verification

Automated tests cover:

- official-provider and model capability detection;
- exact OpenAI, Anthropic, and DeepSeek request payloads;
- unsupported and gateway providers remaining unchanged;
- preservation of existing tools and duplicate prevention;
- native failure guidance to extension fallback;
- citation and server-result round-tripping where supported by Pi.

Live smoke tests are separate and opt-in because native server tools may incur provider charges.
