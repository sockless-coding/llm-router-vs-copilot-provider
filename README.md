# Sockless LLM Router — Copilot Chat Provider

Use models served by your local [Sockless LLM Router](https://www.sockless.tech/projects/sockless-llm-router/) as Copilot Chat models in VS Code. Point the extension at the router's API endpoint and its models appear in the Copilot model picker automatically — no manual per-model configuration.

Sockless LLM Router is a local gateway that manages and launches model server presets (llama.cpp, etc.) and exposes them behind OpenAI- and Anthropic-compatible APIs. See the [project page](https://www.sockless.tech/projects/sockless-llm-router/) and [GitHub repo](https://github.com/sockless-coding/llm-router) for setup and preset configuration.

## Screenshots

Presets configured in the router's admin UI (`Presets`) show up automatically in the Copilot Chat model picker, with context size and tool/vision support carried over:

![Sockless LLM Router Presets admin page](images/router-presets.jpg)

![Copilot model picker listing router presets](images/model-picker.png)

## Setup

1. Install the extension and run **Sockless LLM Router: Configure Connection** from the Command Palette (or open the Copilot model picker — it will prompt you the first time).
2. Enter the router's **API endpoint URL** (the API port, e.g. `http://localhost:5054` — not the admin UI's `5053`).
3. Optionally enter an **API key**, only needed if the router's gateway has "Require API Key" enabled. The key is stored in VS Code's secret storage, never in settings.
4. Open the Copilot Chat model picker — every server preset configured in the router shows up as a model, with the model picker reflecting each one's context size and whether it supports tools/vision.

To change the endpoint or key later, run **Sockless LLM Router: Configure Connection** again.

## How model discovery works

On connect, the extension calls the router's `GET /v1/models/capabilities` endpoint, which reports — per preset — context length, max output tokens, and whether tool calling / image input are supported. That's what lets VS Code populate the model picker without asking you to describe each model by hand.

## Reasoning effort

Presets that support reasoning effort get VS Code's built-in **Thinking Effort** control, the same one it shows for its own reasoning models. Select the model in Copilot Chat and a button showing the current level (e.g. **Medium**) appears next to the model name in the chat input; click it to pick another level. VS Code remembers the choice per model. The button is hidden when the chat view is too narrow, so widen it if you don't see it.

The levels offered are the preset's own `reasoning_effort_options` as reported by the router, and the default is the preset's `--reasoning-effort` launch default, so leaving it alone behaves like the preset's normal configuration. The chosen level is sent as `reasoning_effort` on `/v1/chat/completions`. Presets that don't support it have no effort control and never receive the field.

The control is only offered with the `openai` protocol. The router doesn't yet translate a reasoning-effort level on its `claude`-protocol `/v1/messages` path, so it's hidden while **Sockless LLM Router: Protocol** is `claude`.

## Thinking output

When a model streams its reasoning (`reasoning_content` on the OpenAI protocol, `thinking` blocks on the Claude protocol), it shows up in Copilot Chat's collapsible **Thinking** section instead of being discarded.

## Loaded models

The picker's detail text marks presets the router currently has in memory (`● loaded`), is loading (`◌ loading`) or failed to run (`⚠ error`); hover a row for what that means. An untagged model isn't loaded, so its first request waits for the router to load it, which may unload another model on the same GPU. The list refreshes after a request to a model that wasn't loaded. This needs a router version that reports `load_state` on `/v1/models/capabilities`; older routers just show no tags.

## Protocol

The router speaks two chat protocols side by side, and this extension can use either one — set **Sockless LLM Router: Protocol** (`socklessLlmRouter.protocol`) to:

- `openai` (default) — `POST /v1/chat/completions`, the router's OpenAI-compatible endpoint.
- `claude` — `POST /v1/messages`, the router's Anthropic-compatible endpoint.

Both protocols expose the same presets with the same tool-calling and image-input support, so this is mainly for comparing behavior between the two or matching another Claude-protocol client talking to the same router.

## Requirements

- A running Sockless LLM Router instance with at least one server preset configured.
- VS Code 1.120 or newer (for the Thinking Effort control on extension-provided models).

## Links

- Sockless LLM Router — [project page](https://www.sockless.tech/projects/sockless-llm-router/) · [GitHub](https://github.com/sockless-coding/llm-router)

## Development

```
npm install
npm run compile
```

Press F5 in VS Code to launch an Extension Development Host with the provider loaded.
