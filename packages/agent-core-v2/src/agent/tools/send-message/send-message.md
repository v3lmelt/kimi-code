Deliver a message to a running subagent that you spawned (via the Agent tool). The subagent receives the message as a user message at the start of its next round and can act on it — for example to change direction mid-task, hand over new information, or request a different outcome.

Rules:
- The target must be a subagent you spawned yourself and that is still running (foreground, background, or between rounds). You cannot message agents spawned by other agents, the main agent, or agents that have already finished.
- The message is delivered asynchronously: the target keeps running its current round and processes your message when its next round starts. The tool returns immediately once the message is queued.
- Use the agent id returned by the Agent tool as `to`. The target agent cannot see this channel back — messages are strictly one-way, parent to child.
- For a subagent that already finished, spawn it again with the Agent tool (pass its `resume` id) and only then send messages.
