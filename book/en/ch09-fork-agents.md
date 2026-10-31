# Chapter 9: Fork Agents and the Prompt Cache

## The Ninety-Five Percent Insight

When a parent agent spawns five child agents in parallel, the overwhelming majority of each child's API request is identical. The system prompt is the same. The tool definitions are the same. The conversation history is the same. The assistant message that triggered the spawns is the same. The only thing that differs is the final directive: "you handle the database migration," "you write the tests," "you update the docs."

On a typical fork with a warm conversation, the shared prefix might be 80,000 tokens. The per-child directive might be 200 tokens. That is 99.75% overlap. Anthropic's prompt cache gives a 90% discount on cached input tokens. If you can make those 80,000 tokens hit the cache for children 2 through 5, you just cut the input cost of those four requests by 90%. For the parent, this is the difference between spending $4 and spending $0.50 on the same parallel dispatch.

The catch is that prompt caching is byte-exact. Not "similar enough." Not "semantically equivalent." The bytes must match, character for character, from the first byte of the system prompt through to the last byte before the per-child content diverges. One extra space, one reordered tool definition, one stale feature flag changing a system prompt fragment -- and the cache misses. The entire prefix is reprocessed at full price.

Fork agents are Claude Code's answer to this constraint. They are not just a convenience for "spawn a child with context" -- they are a prompt cache exploitation mechanism disguised as an orchestration feature. Every design decision in the fork system traces back to one question: how do we guarantee byte-identical prefixes across parallel children?

---

## What a Fork Child Inherits

A fork agent inherits four things from its parent, and it inherits them by reference or byte-exact copy, not by recomputation.

**1. The system prompt.** Not regenerated -- threaded. The parent's already-rendered system prompt bytes are passed via `override.systemPrompt`, pulled from `toolUseContext.renderedSystemPrompt`. This is the exact string that was sent in the parent's most recent API call.

**2. The tool definitions.** The fork agent definition declares `tools: ['*']`, but with the `useExactTools` flag set to true, the child receives the parent's assembled tool array directly. No filtering, no reordering, no re-serialization.

**3. The conversation history.** Every message the parent has exchanged with the API -- user turns, assistant turns, tool calls, tool results -- is cloned into the child's context via `forkContextMessages`.

**4. The thinking configuration and model.** The fork definition specifies `model: 'inherit'`, which resolves to the parent's exact model. Same model means same tokenizer, same context window, same cache namespace.

The fork agent definition itself is minimal -- almost a no-op:

The fork agent definition is deliberately minimal -- it inherits everything from the parent. It specifies all tools (`'*'`), inherits the parent's model, uses bubble mode for permissions (so prompts surface in the parent's terminal), and provides a no-op system prompt function that is never actually called -- the real prompt arrives via the override channel, already rendered and byte-stable.

---

## The Byte-Identical Prefix Trick

The API request to Claude has a specific structure: system prompt, then tools, then messages. For the prompt cache to hit, every byte from the start of the request through to some prefix boundary must be identical across requests.

Fork agents achieve this by ensuring three layers are frozen:

**Layer 1: System prompt via threading, not recomputation.**

When the parent agent's system prompt was rendered for its last API call, the result was captured in `toolUseContext.renderedSystemPrompt`. This is the string after all dynamic interpolation -- GrowthBook feature flags, environment details, MCP server descriptions, skill content, CLAUDE.md files. The fork child receives this exact string.

Why not just call `getSystemPrompt()` again? Because system prompt generation is not pure. GrowthBook flags transition from cold to warm state as the SDK fetches remote config. A flag that returned `false` during the parent's first turn might return `true` by the time the fork child spins up. If the system prompt includes a conditional block gated by that flag, the re-rendered prompt diverges by even a single character. Cache busted. Full-price reprocessing of 80,000 tokens, times five children.

Threading the rendered bytes eliminates this entire class of divergence.

**Layer 2: Tool definitions via exact passthrough.**

Normal sub-agents go through `resolveAgentTools()`, which filters the tool pool based on the agent definition's `tools` and `disallowedTools` arrays, applies permission mode differences, and potentially reorders tools. The resulting serialized tool array would differ from the parent's -- different subset, different order, different permission annotations.

Fork agents skip this entirely:

```typescript
const resolvedTools = useExactTools
  ? availableTools  // parent's exact array
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools
```

The `useExactTools` flag is set to true only on the fork path. The child gets the parent's tool pool as-is. Same tools, same order, same serialization. This includes keeping the Agent tool itself in the child's pool, even though the child is forbidden from using it -- removing it would change the tool array and bust the cache.

**Layer 3: Message array construction.**

This is where `buildForkedMessages()` does its careful work. The function constructs the final two messages that sit between the shared history and the per-child directive:

The `buildForkedMessages()` function constructs the final two messages that sit between the shared history and the per-child directive. The algorithm:

1. Clone the parent's assistant message (preserving all `tool_use` blocks with their original IDs).
2. For each `tool_use` block, create a `tool_result` with a constant placeholder string (identical across all children).
3. Build a single user message containing all the placeholder results followed by the per-child directive wrapped in the boilerplate tag.
4. Return `[clonedAssistantMessage, userMessageWithPlaceholdersAndDirective]`.

```typescript
// Pseudocode — illustrates the message construction
function buildChildMessages(directive, parentAssistant) {
  const cloned = cloneMessage(parentAssistant)
  const placeholders = parentAssistant.toolUseBlocks.map(b =>
    toolResult(b.id, CONSTANT_PLACEHOLDER)  // Byte-identical across children
  )
  const userMsg = createUserMessage([...placeholders, wrapDirective(directive)])
  return [cloned, userMsg]
}
```

The resulting message array for each child looks like:

```
[...shared_history, assistant(all_tool_uses), user(placeholder_results..., directive)]
```

Every element before the directive is identical across children. The `FORK_PLACEHOLDER_RESULT` -- a constant string `'Fork started -- processing in background'` -- ensures even the tool result blocks are byte-identical. The `tool_use_id` values are identical because they reference the same assistant message. Only the final text block, containing the per-child directive, varies.

The cache boundary falls right before that final text block. Everything above it -- potentially tens of thousands of tokens of system prompt, tool definitions, conversation history, and placeholder results -- hits the cache at a 90% discount for every child after the first.

---

## The Fork Boilerplate Tag

Each child's directive is wrapped in a boilerplate XML tag that serves two purposes: it instructs the child on how to behave, and it acts as a marker for recursive fork detection.

The boilerplate contains approximately 10 rules. The key ones:

- **Override the parent's forking instruction.** The parent's system prompt says "default to forking" -- the boilerplate explicitly tells the child: "that instruction is for the parent. You ARE the fork. Do NOT spawn sub-agents."
- **Execute silently, report once.** No conversational text between tool calls. Use tools directly, then produce a structured summary.
- **Stay within scope.** The child must not expand beyond its directive.
- **Structured output format.** The response must follow a Scope/Result/Key files/Files changed/Issues template that makes results easy for the parent to parse when multiple children report back simultaneously.

Rule 1 is particularly interesting. The parent's system prompt -- which the fork child inherits verbatim for cache reasons -- contains instructions like "default to forking when you have parallel work." If the child followed that instruction, it would try to fork its own children, creating an infinite recursion of agents. The boilerplate explicitly overrides: "that instruction is for the parent. You ARE the fork."

The structured output format (Scope/Result/Key files/Files changed/Issues) is not decorative. It constrains the child's output to factual reporting, which makes the results easier for the parent to parse and aggregate when five children report back simultaneously.

---

## Recursive Fork Prevention

The fork child keeps the Agent tool in its tool pool. It has to -- removing it would change the serialized tool array and bust the prompt cache. But if the child actually invokes the Agent tool without `subagent_type`, the fork path would trigger again, creating a grandchild fork. This grandchild would inherit an even larger context (parent + child conversation), spawn its own forks, and so on.

Two guards prevent this:

**Primary guard: querySource check.** When a fork child is spawned, its `context.options.querySource` is set to `'agent:builtin:fork'`. The `call()` method checks this before allowing the fork path:

```typescript
// In AgentTool.call():
if (effectiveType === undefined) {
  // Fork path -- but are we already in a fork?
  if (querySource === 'agent:builtin:fork') {
    // Reject: already a fork child
  }
}
```

This is the fast path. It checks a single string in the options object.

**Fallback guard: message scanning.** Fork prevention uses two guards: the `querySource` tag set at spawn time (the fast path -- a single string comparison), and a fallback that scans message history for the boilerplate XML tag. The fallback exists because the `querySource` survives autocompact, but in edge cases where it was not properly threaded, the message-scanning fallback catches the recursion. It is a belt-and-suspenders approach where the cost of the check (scanning messages) is trivial compared to the cost of accidental recursive forking (runaway API spend).

Why the fallback? Because Claude Code has an autocompact feature that rewrites the message array when context gets too long. Autocompact can rewrite message content but preserves the `querySource` in options. In theory, `querySource` alone is sufficient. In practice, the message-scanning fallback catches edge cases where `querySource` was not properly threaded -- a belt-and-suspenders approach where the cost of the check (scanning messages) is trivial compared to the cost of accidental recursive forking (runaway API spend).

---

## The Sync-to-Async Transition

A fork child starts running in the foreground: its messages stream to the parent's terminal, and the parent blocks waiting for completion. But what if the child is taking too long? Claude Code allows mid-execution backgrounding -- the user (or an auto-timeout) can push a running foreground agent into the background without losing any work.

The mechanism is surprisingly clean:

1. When a foreground agent is registered via `registerAgentForeground()`, a background signal promise is created.

2. The parent's sync loop races between the agent's message stream and the background signal:

```
while (true) {
  const result = await Promise.race([
    iterator.next(),         // next message from agent
    backgroundSignal,        // "move to background" trigger
  ])
  if (result === BACKGROUND_SIGNAL) break
  // ... process message
}
```

3. When the background signal fires, the foreground iterator is gracefully terminated via `iterator.return()`. This triggers the generator's `finally` block, which handles cleanup.

4. A new `runAgent()` instance is spawned with `isAsync: true`, using the same agent ID and the message history accumulated so far. The agent continues from where it left off, now running in the background.

5. The original synchronous `call()` returns `{ status: 'async_launched' }`, and the parent continues its conversation.

No work is lost because the message history is the agent's state. The sidechain transcript on disk has every message the agent has produced. The new async instance replays from this transcript and picks up where the sync instance stopped.

---

## Auto-Backgrounding

When the `CLAUDE_AUTO_BACKGROUND_TASKS` environment variable or the `tengu_auto_background_agents` GrowthBook flag is enabled, foreground agents are automatically backgrounded after 120 seconds:

When enabled via environment variable or feature flag, foreground agents are automatically backgrounded after 120 seconds. When disabled, the function returns 0 (no auto-backgrounding).

This is a UX decision with cost implications. A foreground agent blocks the parent terminal -- the user cannot type, cannot issue new instructions, cannot spawn other agents. Two minutes is long enough for the agent to complete most quick tasks synchronously (where the streaming output is useful feedback), but short enough that long-running tasks do not hold the terminal hostage.

Under the fork experiment, the auto-backgrounding question is moot: all fork spawns are forced async from the start. The `run_in_background` parameter is hidden from the schema entirely. Every fork child runs in the background, reports back via a `<task-notification>` when done, and the parent never blocks.

---

## When Fork Is NOT Used

Fork is one of several orchestration modes, and it is deliberately excluded in three cases:

**Coordinator mode.** Coordinator mode and fork mode are mutually exclusive. A coordinator has a structured delegation model: it maintains a plan, assigns tasks to workers with explicit prompts, and tracks progress. Fork's "inherit everything" approach would undermine this. A forked coordinator would inherit the parent coordinator's system prompt (which says "you are the coordinator, delegate work"), and the child would try to orchestrate instead of execute. The `isForkSubagentEnabled()` function checks `isCoordinatorMode()` first and returns false if active.

**Non-interactive sessions.** SDK and API consumers (`--print` mode, Claude Agent SDK) operate without a terminal. Fork's `permissionMode: 'bubble'` surfaces permission prompts to the parent terminal -- which does not exist in non-interactive mode. Rather than building a separate permission flow, the fork path is simply disabled. SDK consumers use explicit `subagent_type` selection instead.

**Explicit subagent_type.** When the model specifies a `subagent_type` (e.g., `"Explore"`, `"Plan"`, `"general-purpose"`), the fork path is not triggered. Fork only fires when `subagent_type` is omitted. This lets the model choose between "I want a specialized agent with its own system prompt and tool set" (explicit type) and "I want a context-inheriting clone of myself to handle this in parallel" (omitted type).

---

## The Economics

Consider a concrete scenario. A developer asks Claude Code to refactor a module. The parent agent analyzes the codebase, forms a plan, and dispatches five fork children in parallel: one to update the database schema, one to rewrite the service layer, one to update the router, one to fix the tests, and one to update the types.

At this point in the conversation, the shared context is substantial:
- System prompt: ~4,000 tokens
- Tool definitions (40+ tools): ~12,000 tokens
- Conversation history (analysis + planning): ~30,000 tokens
- Assistant message with five tool_use blocks: ~2,000 tokens
- Placeholder tool results: ~500 tokens

Total shared prefix: ~48,500 tokens. Per-child directive: ~200 tokens.

Without fork (five independent agents, each with fresh context and their own system prompt):
- Each child processes its own system prompt + tools + task prompt
- No cache sharing (different system prompts, different tool sets)
- Cost: 5 x full input processing

With fork (byte-identical prefixes):
- Child 1: 48,700 tokens at full price (cache miss on first request)
- Children 2-5: 48,500 tokens at 10% price (cache hit) + 200 tokens at full price each
- Effective cost for children 2-5: ~4,850 + 200 = ~5,050 tokens equivalent each

The savings scale with context size and child count. For a warm session with 100K tokens of history spawning 8 parallel forks, the cache savings can exceed 90% of what the input tokens would have cost without sharing.

This is why every design decision in the fork system -- the threading instead of recomputation, the exact tool passthrough, the placeholder results, even keeping the Agent tool in the child's pool despite it being forbidden -- optimizes for one thing: byte-identical prefixes. Each decision trades a small amount of elegance or safety for a measurable reduction in API cost.

---

## Design Tensions

The fork system makes explicit trade-offs that are worth understanding:

**Isolation vs. cache efficiency.** Fork children inherit everything, including conversation history that may be irrelevant to their task. A child rewriting tests does not need the 15 messages where the parent discussed database schema design. But including those messages is what makes the prefix identical. Stripping irrelevant history would save context window space at the cost of busting the cache. The design bet is that cache savings outweigh the context overhead.

**Safety vs. cache efficiency.** The Agent tool stays in the fork child's tool pool even though the child must not use it. Removing it would be safer (the child cannot even attempt to fork), but would change the tool array serialization. The boilerplate tag and recursive fork guards are the compensating controls -- runtime prevention instead of static removal.

**Simplicity vs. cache efficiency.** The placeholder tool results are a lie. The child sees `'Fork started -- processing in background'` for every tool_use block in the parent's assistant message, regardless of what those tool calls actually did. This is fine because the child's directive tells it what to do -- it does not need accurate tool results from the parent's dispatching turn. But it means the child's conversation history is technically incoherent. The placeholder is chosen for brevity and uniformity, not accuracy.

Each of these trade-offs reflects the same priority: when you are paying per-token for API calls at scale, byte-identical prefixes are worth contorting the architecture around.

---

## Apply This: Designing for Prompt Cache Efficiency

The fork agent pattern generalizes beyond Claude Code. Any system that dispatches multiple parallel LLM calls from the same context can benefit from cache-aware request construction. The principles:

**1. Thread rendered prompts, do not recompute.** If your system prompt includes any dynamic content -- feature flags, timestamps, user preferences, A/B test variants -- capture the rendered result and pass it to children by value. Recomputing risks divergence.

**2. Freeze the tool array.** If your children need different tool sets, you are giving up cache sharing on the tools block. Consider keeping the full tool set and using runtime guards (like the fork boilerplate's "do not use Agent") instead of compile-time removal.

**3. Maximize the shared prefix, minimize the per-child suffix.** Structure your message array so that everything shared comes first and per-child content is appended at the end. Interleaving shared and per-child content fragments the cache boundary.

**4. Use constant placeholders for variable content.** When the message structure requires responses to previous tool calls, use identical placeholder strings across all children rather than actual (divergent) results.

**5. Measure the break-even.** Cache sharing has overhead: larger context windows per child (they carry irrelevant history), runtime guards instead of static safety, architectural complexity. Calculate whether your parallelism pattern (how many children, how large the shared prefix) actually saves money after accounting for the extra context tokens.

The fork agent system is, at its core, a prompt cache exploitation engine. It answers a question that every multi-agent system builder eventually faces: when the cache gives you a 90% discount on repeated prefixes, how far will you restructure your architecture to claim that discount? Claude Code's answer is: very far.
