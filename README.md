# Sockless LLM Router — Copilot Chat Provider

Use models served by your local Sockless LLM Router as Copilot Chat models in VS Code. Point the extension at the router's API endpoint and its models appear in the Copilot model picker automatically — no manual per-model configuration.

## Setup

1. Install the extension and run **Sockless LLM Router: Configure Connection** from the Command Palette (or open the Copilot model picker — it will prompt you the first time).
2. Enter the router's **API endpoint URL** (the API port, e.g. `http://localhost:5054` — not the admin UI's `5053`).
3. Optionally enter an **API key**, only needed if the router's gateway has "Require API Key" enabled. The key is stored in VS Code's secret storage, never in settings.
4. Open the Copilot Chat model picker — every server preset configured in the router shows up as a model, with the model picker reflecting each one's context size and whether it supports tools/vision.

To change the endpoint or key later, run **Sockless LLM Router: Configure Connection** again.

## How model discovery works

On connect, the extension calls the router's `GET /v1/models/capabilities` endpoint, which reports — per preset — context length, max output tokens, and whether tool calling / image input are supported. That's what lets VS Code populate the model picker without asking you to describe each model by hand.

## Protocol

The router speaks two chat protocols side by side, and this extension can use either one — set **Sockless LLM Router: Protocol** (`socklessLlmRouter.protocol`) to:

- `openai` (default) — `POST /v1/chat/completions`, the router's OpenAI-compatible endpoint.
- `claude` — `POST /v1/messages`, the router's Anthropic-compatible endpoint.

Both protocols expose the same presets with the same tool-calling and image-input support, so this is mainly for comparing behavior between the two or matching another Claude-protocol client talking to the same router.

## Requirements

- A running Sockless LLM Router instance with at least one server preset configured.
- VS Code 1.104 or newer (for the Language Model Chat Provider API).

## Development

```
npm install
npm run compile
```

Press F5 in VS Code to launch an Extension Development Host with the provider loaded.
