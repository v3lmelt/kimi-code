---
"@moonshot-ai/kimi-code": minor
---

Enable subagent model selection by default. The `Agent` and `AgentSwarm` tools now expose a `model` parameter without enabling an experimental flag, and the `/secondary_model` slash command is always available. Configure `[secondary_model]` in `config.toml` or run `/secondary_model` in the TUI to set a default secondary model for spawned subagents.
