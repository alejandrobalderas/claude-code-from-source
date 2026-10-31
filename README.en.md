# Claude Code from Source

**Architecture, Patterns & Internals of Anthropic's AI Coding Agent**

<p align="center">
  <img src="./web/public/cover.jpg" alt="Claude Code from Source — Book Cover" width="400" />
  <br/><br/>
  <a href="https://claude-code-from-source.com"><strong>Read online at claude-code-from-source.com</strong></a>
</p>

---

> **This repository is purely educational.** It contains no source code from Claude Code — not a single line. Every code block is original pseudocode written to illustrate architectural patterns. The goal is to help engineers understand how production AI agents are built, not to reproduce or redistribute proprietary software.

---

When Anthropic shipped Claude Code on npm, the `.js.map` source maps contained a `sourcesContent` field with the full original TypeScript. This book is the result of studying that architecture and distilling the patterns, trade-offs, and design decisions into a technical narrative that any engineer can learn from.

**18 chapters across 7 parts.** ~400 pages in print equivalent.

Every chapter has layered depth: a narrative flow for technical leaders, deep-dive sections for implementers, and an **"Apply This"** closing that extracts transferable patterns you can steal for your own systems. Diagrams use [Mermaid](https://mermaid.js.org/) and render natively on GitHub.

---

## Who This Is For

- **Senior engineers building agentic systems** — steal the patterns, understand the trade-offs, implement in your own stack
- **Technical leaders evaluating architectures** — follow the narrative without reading every code block
- **Anyone curious about how production AI tools actually work** under the hood

---

## Table of Contents

### Part I: Foundations
*Before the agent can think, the process must exist.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 1 | [The Architecture of an AI Agent](./book/ch01-architecture.md) | The 6 key abstractions, data flow, permission system, build system |
| 2 | [Starting Fast — The Bootstrap Pipeline](./book/ch02-bootstrap.md) | 5-phase init, module-level I/O parallelism, trust boundary |
| 3 | [State — The Two-Tier Architecture](./book/ch03-state.md) | Bootstrap singleton, AppState store, sticky latches, cost tracking |
| 4 | [Talking to Claude — The API Layer](./book/ch04-api-layer.md) | Multi-provider client, prompt cache, streaming, error recovery |

### Part II: The Core Loop
*The heartbeat of the agent: stream, act, observe, repeat.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 5 | [The Agent Loop](./book/ch05-agent-loop.md) | query.ts deep dive, 4-layer compression, error recovery, token budgets |
| 6 | [Tools — From Definition to Execution](./book/ch06-tools.md) | Tool interface, 14-step pipeline, permission system |
| 7 | [Concurrent Tool Execution](./book/ch07-concurrency.md) | Partition algorithm, streaming executor, speculative execution |

### Part III: Multi-Agent Orchestration
*One agent is powerful. Many agents working together are transformative.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 8 | [Spawning Sub-Agents](./book/ch08-sub-agents.md) | AgentTool, 15-step runAgent lifecycle, built-in agent types |
| 9 | [Fork Agents and the Prompt Cache](./book/ch09-fork-agents.md) | Byte-identical prefix trick, cache sharing, cost optimization |
| 10 | [Tasks, Coordination, and Swarms](./book/ch10-coordination.md) | Task state machine, coordinator mode, swarm messaging |

### Part IV: Persistence and Intelligence
*An agent without memory makes the same mistakes forever.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 11 | [Memory — Learning Across Conversations](./book/ch11-memory.md) | File-based memory, 4-type taxonomy, LLM recall, staleness |
| 12 | [Extensibility — Skills and Hooks](./book/ch12-extensibility.md) | Two-phase skill loading, lifecycle hooks, snapshot security |

### Part V: The Interface
*Everything the user sees passes through this layer.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 13 | [The Terminal UI](./book/ch13-terminal-ui.md) | Custom Ink fork, rendering pipeline, double-buffer, pools |
| 14 | [Input and Interaction](./book/ch14-input-interaction.md) | Key parsing, keybindings, chord support, vim mode |

### Part VI: Connectivity
*The agent reaches beyond localhost.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 15 | [MCP — The Universal Tool Protocol](./book/ch15-mcp.md) | 8 transports, OAuth for MCP, tool wrapping |
| 16 | [Remote Control and Cloud Execution](./book/ch16-remote.md) | Bridge v1/v2, CCR, upstream proxy |

### Part VII: Performance Engineering
*Making it all fast enough that humans don't notice the machinery.*

| # | Chapter | What You'll Learn |
|---|---------|-------------------|
| 17 | [Performance — Every Millisecond and Token Counts](./book/ch17-performance.md) | Startup, context window, prompt cache, rendering, search |
| 18 | [Epilogue — What We Learned](./book/ch18-epilogue.md) | The 5 architectural bets, what transfers, where agents are heading |

---

## The 10 Patterns That Make It Work

If you read nothing else:

1. **AsyncGenerator as agent loop** — yields Messages, typed Terminal return, natural backpressure and cancellation
2. **Speculative tool execution** — start read-only tools during model streaming, before the response completes
3. **Concurrent-safe batching** — partition tools by safety, run reads in parallel, serialize writes
4. **Fork agents for cache sharing** — parallel children share byte-identical prompt prefixes, saving ~95% input tokens
5. **4-layer context compression** — snip, microcompact, collapse, autocompact — each lighter than the next
6. **File-based memory with LLM recall** — Sonnet side-query selects relevant memories, not keyword matching
7. **Two-phase skill loading** — frontmatter only at startup, full content on invocation
8. **Sticky latches for cache stability** — once a beta header is sent, never unset mid-session
9. **Slot reservation** — 8K default output cap, escalate to 64K on hit (saves context in 99% of requests)
10. **Hook config snapshot** — freeze at startup to prevent runtime injection attacks

---

## How This Book Was Made

The source was extracted from npm source maps. 36 AI agents analyzed nearly two thousand TypeScript files in four phases:

1. **Exploration**: 6 parallel agents read every file in the source tree
2. **Analysis**: 12 agents wrote 494KB of raw technical documentation
3. **Writing**: 15 agents rewrote everything from scratch as narrative chapters
4. **Review & Revision**: 3 editorial reviewers produced 900 lines of feedback; 3 revision agents applied all fixes

The entire process — from source extraction to final revised book — took approximately 6 hours.

---

## Disclaimer

**This repository does not contain any source code from Claude Code.** All code blocks are original pseudocode using different variable names, written to illustrate architectural patterns. No proprietary prompt text, internal constants, or exact function implementations are included. This project exists purely for educational purposes — to help engineers understand the design patterns behind production AI coding agents.

The "NO'REILLY" cover is a parody/meme for illustrative purposes only. This project has no affiliation with O'Reilly Media. The crab is just a crab.

This is an independent analysis. Claude Code is a product of Anthropic. This book is not affiliated with, endorsed by, or sponsored by Anthropic.
