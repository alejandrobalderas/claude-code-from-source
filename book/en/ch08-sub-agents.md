# Chapter 8: Spawning Sub-Agents

## The Multiplication of Intelligence

A single agent is powerful. It can read files, edit code, run tests, search the web, and reason about the results. But there is a hard ceiling on what one agent can do in a single conversation: the context window fills up, the task branches in directions that demand different capabilities, and the serial nature of tool execution becomes a bottleneck. The solution is not a bigger model. It is more agents.

Claude Code's sub-agent system lets the model request help. When the parent agent encounters a task that would benefit from delegation -- a codebase search that should not pollute the main conversation, a verification pass that demands adversarial thinking, a set of independent edits that could run in parallel -- it calls the `Agent` tool. That call spawns a child: a fully independent agent with its own conversation loop, its own tool set, its own permission boundary, and its own abort controller. The child does its work and returns a result. The parent never sees the child's internal reasoning, only the final output.

This is not a convenience feature. It is the architectural foundation for everything from parallel file exploration to coordinator-worker hierarchies to multi-agent swarm teams. And it all flows through two files: `AgentTool.tsx`, which defines the model-facing interface, and `runAgent.ts`, which implements the lifecycle.

The design challenge is significant. A sub-agent needs enough context to do its job but not so much that it wastes tokens on irrelevant information. It needs permission boundaries that are strict enough for safety but flexible enough for utility. It needs lifecycle management that cleans up every resource it touches without requiring the caller to remember what to clean up. And all of this must work for a spectrum of agent types -- from a cheap, fast, read-only Haiku searcher to an expensive, thorough, Opus-powered verification agent running adversarial tests in the background.

This chapter traces the path from the model's "I need help" to a fully operational child agent. We will examine the tool definition that the model sees, the fifteen-step lifecycle that creates the execution environment, the six built-in agent types and what each optimizes for, the frontmatter system that lets users define custom agents, and the design principles that emerge from all of it.

A note on terminology: throughout this chapter, "parent" refers to the agent that calls the `Agent` tool, and "child" refers to the agent that is spawned. The parent is usually (but not always) the top-level REPL agent. In coordinator mode, the coordinator spawns workers, which are children. In nested scenarios, a child can itself spawn grandchildren -- the same lifecycle applies recursively.

The orchestration layer spans approximately 40 files across `tools/AgentTool/`, `tasks/`, `coordinator/`, `tools/SendMessageTool/`, and `utils/swarm/`. This chapter focuses on the spawning mechanics -- the AgentTool definition and the runAgent lifecycle. The next chapter covers the runtime: progress tracking, result retrieval, and multi-agent coordination patterns.

---

## The AgentTool Definition

The `AgentTool` is registered under the name `"Agent"` with a legacy alias `"Task"` for backward compatibility with older transcripts, permission rules, and hook configurations. It is built with the standard `buildTool()` factory, but its schema is more dynamic than any other tool in the system.

### The Input Schema

The input schema is constructed lazily via `lazySchema()` -- a pattern we saw in Chapter 6 that defers zod compilation until first use. There are two layers: a base schema and a full schema that adds multi-agent and isolation parameters.

The base fields are always present:

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `description` | `string` | Yes | Short 3-5 word summary of the task |
| `prompt` | `string` | Yes | The full task description for the agent |
| `subagent_type` | `string` | No | Which specialized agent to use |
| `model` | `enum('sonnet','opus','haiku')` | No | Model override for this agent |
| `run_in_background` | `boolean` | No | Launch asynchronously |

The full schema adds multi-agent parameters (when swarm features are active) and isolation controls:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Makes the agent addressable via `SendMessage({to: name})` |
| `team_name` | `string` | Team context for spawning |
| `mode` | `PermissionMode` | Permission mode for spawned teammate |
| `isolation` | `enum('worktree','remote')` | Filesystem isolation strategy |
| `cwd` | `string` | Absolute path override for working directory |

The multi-agent fields enable the swarm pattern covered in Chapter 9: named agents that can send messages to each other via `SendMessage({to: name})` while running concurrently. The isolation fields enable filesystem safety: worktree isolation creates a temporary git worktree so the agent operates on a copy of the repository, preventing conflicting edits when multiple agents work on the same codebase simultaneously.

What makes this schema unusual is that it is **dynamically shaped by feature flags**:

```typescript
// Pseudocode — illustrates the feature-gated schema pattern
inputSchema = lazySchema(() => {
  let schema = baseSchema()
  if (!featureEnabled('ASSISTANT_MODE')) schema = schema.omit({ cwd: true })
  if (backgroundDisabled || forkMode)    schema = schema.omit({ run_in_background: true })
  return schema
})
```

When the fork experiment is active, `run_in_background` disappears from the schema entirely because all spawns are forced async under that path. When background tasks are disabled (via `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`), the field is also stripped. When the KAIROS feature flag is off, `cwd` is omitted. The model never sees fields it cannot use.

This is a subtle but important design choice. The schema is not just validation -- it is the model's instruction manual. Every field in the schema is described in the tool definition that the model reads. Removing fields the model should not use is more effective than adding "do not use this field" to the prompt. The model cannot misuse what it cannot see.

### The Output Schema

The output is a discriminated union with two public variants:

- `{ status: 'completed', prompt, ...AgentToolResult }` -- synchronous completion with the agent's final output
- `{ status: 'async_launched', agentId, description, prompt, outputFile }` -- background launch acknowledgment

Two additional internal variants (`TeammateSpawnedOutput` and `RemoteLaunchedOutput`) exist but are excluded from the exported schema to enable dead code elimination in external builds. The bundler strips these variants and their associated code paths when the corresponding feature flags are disabled, keeping the distributed binary smaller.

The `async_launched` variant is notable for what it includes: the `outputFile` path where the agent's results will be written when it completes. This lets the parent (or any other consumer) poll or watch the file for results, providing a filesystem-based communication channel that survives process restarts.

### The Dynamic Prompt

The `AgentTool` prompt is generated by `getPrompt()` and is context-sensitive. It adapts based on available agents (listed inline or as an attachment to avoid busting prompt cache), whether fork is active (adds "When to fork" guidance), whether the session is in coordinator mode (slim prompt since the coordinator system prompt already covers usage), and subscription tier. Non-pro users get a note about launching multiple agents concurrently.

The attachment-based agent list is worth highlighting. The codebase comments reference "approximately 10.2% of fleet cache_creation tokens" being caused by dynamic tool descriptions. Moving the agent list from the tool description to an attachment message keeps the tool description static, so connecting an MCP server or loading a plugin does not bust the prompt cache for every subsequent API call.

This is a pattern worth internalizing for any system that uses tool definitions with dynamic content. The Anthropic API caches the prompt prefix -- system prompt, tool definitions, and conversation history -- and reuses the cached computation for subsequent requests that share the same prefix. If the tool definition changes between API calls (because an agent was added or an MCP server connected), the entire cache is invalidated. Moving volatile content from the tool definition (which is part of the cached prefix) to an attachment message (which is appended after the cached portion) preserves the cache while still delivering the information to the model.

With the tool definition understood, we can now trace what happens when the model actually calls it.

### Feature Gating

The sub-agent system has the most complex feature gating in the codebase. At least twelve feature flags and GrowthBook experiments control which agents are available, which parameters appear in the schema, and which code paths are taken:

| Feature Gate | Controls |
|-------------|----------|
| `FORK_SUBAGENT` | Fork agent path |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Explore and Plan agents |
| `VERIFICATION_AGENT` | Verification agent |
| `KAIROS` | `cwd` override, assistant force-async |
| `TRANSCRIPT_CLASSIFIER` | Handoff classification, `auto` mode override |
| `PROACTIVE` | Proactive module integration |

Each gate uses `feature()` from Bun's dead code elimination system (compile-time) or `getFeatureValue_CACHED_MAY_BE_STALE()` from GrowthBook (runtime A/B testing). The compile-time gates are string-replaced during the build -- when `FORK_SUBAGENT` is `'ant'`, the entire fork code path is included; when it is `'external'`, it may be excluded entirely. The GrowthBook gates allow live experimentation: the `tengu_amber_stoat` experiment can A/B test whether removing Explore and Plan agents changes user behavior, without shipping a new binary.

### The call() Decision Tree

Before `runAgent()` is ever invoked, the `call()` method in `AgentTool.tsx` routes the request through a decision tree that determines *what kind* of agent to spawn and *how* to spawn it:

```
1. Is this a teammate spawn? (team_name + name both set)
   YES -> spawnTeammate() -> return teammate_spawned
   NO  -> continue

2. Resolve effective agent type
   - subagent_type provided -> use it
   - subagent_type omitted, fork enabled -> undefined (fork path)
   - subagent_type omitted, fork disabled -> "general-purpose" (default)

3. Is this the fork path? (effectiveType === undefined)
   YES -> Recursive fork guard check -> Use FORK_AGENT definition

4. Resolve agent definition from activeAgents list
   - Filter by permission deny rules
   - Filter by allowedAgentTypes
   - Throw if not found or denied

5. Check required MCP servers (wait up to 30s for pending)

6. Resolve isolation mode (param overrides agent def)
   - "remote" -> teleportToRemote() -> return remote_launched
   - "worktree" -> createAgentWorktree()
   - null -> normal execution

7. Determine sync vs async
   shouldRunAsync = run_in_background || selectedAgent.background ||
                    isCoordinator || forceAsync || isProactiveActive

8. Assemble worker tool pool

9. Build system prompt and prompt messages

10. Execute (async -> registerAsyncAgent + void lifecycle; sync -> iterate runAgent)
```

Steps 1 through 6 are pure routing -- no agent has been created yet. The actual lifecycle begins at `runAgent()`, which the sync path iterates directly and the async path wraps in `runAsyncAgentLifecycle()`.

The routing is done in `call()` rather than `runAgent()` for a reason: `runAgent()` is a pure lifecycle function that does not know about teammates, remote agents, or the fork experiment. It receives a resolved agent definition and executes it. The decision of *which* definition to resolve, *how* to isolate the agent, and *whether* to run synchronously or asynchronously belongs to the layer above. This separation keeps `runAgent()` testable and reusable -- it is called from both the normal AgentTool path and from the async lifecycle wrapper when resuming a backgrounded agent.

The fork guard in step 3 deserves attention. Fork children keep the `Agent` tool in their pool (for cache-identical tool definitions with the parent), but recursive forking would be pathological. Two guards prevent it: `querySource === 'agent:builtin:fork'` (set on the child's context options, survives autocompact) and `isInForkChild(messages)` (scans conversation history for the `<fork-boilerplate>` tag as a fallback). Belt and suspenders -- the primary guard is fast and reliable; the fallback catches edge cases where querySource was not threaded.

---

## The runAgent Lifecycle

`runAgent()` in `runAgent.ts` is an async generator that drives a sub-agent's entire lifecycle. It yields `Message` objects as the agent works. Every sub-agent -- fork, built-in, custom, coordinator worker -- flows through this single function. The function is approximately 400 lines, and every line exists for a reason.

The function signature reveals the complexity of the problem:

```typescript
export async function* runAgent({
  agentDefinition,       // What kind of agent
  promptMessages,        // What to tell it
  toolUseContext,        // Parent's execution context
  canUseTool,           // Permission callback
  isAsync,              // Background or blocking?
  canShowPermissionPrompts,
  forkContextMessages,  // Parent's history (fork only)
  querySource,          // Origin tracking
  override,             // System prompt, abort controller, agent ID overrides
  model,                // Model override from caller
  maxTurns,             // Turn limit
  availableTools,       // Pre-assembled tool pool
  allowedTools,         // Permission scoping
  onCacheSafeParams,    // Callback for background summarization
  useExactTools,        // Fork path: use parent's exact tools
  worktreePath,         // Isolation directory
  description,          // Human-readable task description
  // ...
}: { ... }): AsyncGenerator<Message, void>
```

Seventeen parameters. Each one represents a dimension of variation that the lifecycle must handle. This is not over-engineering -- it is the natural consequence of a single function serving fork agents, built-in agents, custom agents, sync agents, async agents, worktree-isolated agents, and coordinator workers. The alternative would be seven different lifecycle functions with duplicated logic, which is worse.

The `override` object is particularly important -- it is the escape hatch for fork agents and resumed agents that need to inject pre-computed values (system prompt, abort controller, agent ID) into the lifecycle without re-deriving them.

Here are the fifteen steps.

### Step 1: Model Resolution

```typescript
const resolvedAgentModel = getAgentModel(
  agentDefinition.model,                    // Agent's declared preference
  toolUseContext.options.mainLoopModel,      // Parent's model
  model,                                    // Caller's override (from input)
  permissionMode,                           // Current permission mode
)
```

The resolution chain is: **caller override > agent definition > parent model > default**. The `getAgentModel()` function handles special values like `'inherit'` (use whatever the parent uses) and GrowthBook-gated overrides for specific agent types. The Explore agent, for example, defaults to Haiku for external users -- the cheapest and fastest model, appropriate for a read-only search specialist that runs 34 million times per week.

Why this order matters: the caller (the parent model) can override the agent definition's preference by passing a `model` parameter in the tool call. This lets the parent promote a normally-cheap agent to a more capable model for a particularly complex search, or demote an expensive agent when the task is simple. But the agent definition's model is the default, not the parent's -- a Haiku Explore agent should not accidentally inherit the parent's Opus model just because no one specified otherwise.

Understanding the model resolution chain is important because it establishes a design principle that recurs throughout the lifecycle: **explicit overrides beat declarations, declarations beat inheritance, inheritance beats defaults.** This same principle governs permission modes, abort controllers, and system prompts. The consistency makes the system predictable -- once you understand one resolution chain, you understand them all.

### Step 2: Agent ID Creation

```typescript
const agentId = override?.agentId ? override.agentId : createAgentId()
```

Agent IDs follow the pattern `agent-<hex>` where the hex part is derived from `crypto.randomUUID()`. The branded type `AgentId` prevents accidental string confusion at the type level. The override path exists for resumed agents that need to keep their original ID for transcript continuity.

### Step 3: Context Preparation

Fork agents and fresh agents diverge here:

```typescript
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)
  : []
const initialMessages: Message[] = [...contextMessages, ...promptMessages]

const agentReadFileState = forkContextMessages !== undefined
  ? cloneFileStateCache(toolUseContext.readFileState)
  : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
```

For fork agents, the parent's entire conversation history is cloned into `contextMessages`. But there is a critical filter: `filterIncompleteToolCalls()` strips any `tool_use` blocks that lack matching `tool_result` blocks. Without this filter, the API would reject the malformed conversation. This happens when the parent is mid-tool-execution at the moment of forking -- the tool_use has been emitted but the result has not arrived yet.

The file state cache follows the same fork-or-fresh pattern. Fork children get a clone of the parent's cache (they already "know" which files have been read). Fresh agents start empty. The clone is a shallow copy -- file content strings are shared via reference, not duplicated. This matters for memory: a fork child with a 50-file cache does not duplicate 50 file contents, it duplicates 50 pointers. The LRU eviction behavior is independent -- each cache evicts based on its own access pattern.

### Step 4: CLAUDE.md Stripping

Read-only agents like Explore and Plan have `omitClaudeMd: true` in their definitions:

```typescript
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&
  !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } = baseUserContext
const resolvedUserContext = shouldOmitClaudeMd
  ? userContextNoClaudeMd
  : baseUserContext
```

CLAUDE.md files contain project-specific instructions about commit messages, PR conventions, lint rules, and coding standards. A read-only search agent does not need any of this -- it cannot commit, cannot create PRs, cannot edit files. The parent agent has full context and will interpret the search results. Dropping CLAUDE.md here saves billions of tokens per week across the fleet -- an aggregate cost reduction that justifies the added complexity of conditional context injection.

Similarly, Explore and Plan agents have `gitStatus` stripped from system context. The git status snapshot taken at session start can be up to 40KB and is explicitly labeled as stale. If these agents need git information, they can run `git status` themselves and get fresh data.

These are not premature optimizations. At 34 million Explore spawns per week, every unnecessary token compounds into measurable cost. The kill-switch (`tengu_slim_subagent_claudemd`) defaults to true but can be flipped via GrowthBook if the stripping causes regressions.

### Step 5: Permission Isolation

This is the most intricate step. Each agent gets a custom `getAppState()` wrapper that overlays its permission configuration onto the parent's state:

```typescript
const agentGetAppState = () => {
  const state = toolUseContext.getAppState()
  let toolPermissionContext = state.toolPermissionContext

  // Override mode unless parent is in bypassPermissions, acceptEdits, or auto
  if (agentPermissionMode && canOverride) {
    toolPermissionContext = {
      ...toolPermissionContext,
      mode: agentPermissionMode,
    }
  }

  // Auto-deny prompts for agents that can't show UI
  const shouldAvoidPrompts =
    canShowPermissionPrompts !== undefined
      ? !canShowPermissionPrompts
      : agentPermissionMode === 'bubble'
        ? false
        : isAsync
  if (shouldAvoidPrompts) {
    toolPermissionContext = {
      ...toolPermissionContext,
      shouldAvoidPermissionPrompts: true,
    }
  }

  // Scope tool allow rules
  if (allowedTools !== undefined) {
    toolPermissionContext = {
      ...toolPermissionContext,
      alwaysAllowRules: {
        cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
        session: [...allowedTools],
      },
    }
  }

  return { ...state, toolPermissionContext, effortValue }
}
```

There are four distinct concerns layered together:

**Permission mode cascade.** If the parent is in `bypassPermissions`, `acceptEdits`, or `auto` mode, the parent's mode always wins -- the agent definition cannot weaken it. Otherwise, the agent definition's `permissionMode` is applied. This prevents a custom agent from downgrading security when the user has explicitly set a permissive mode for the session.

**Prompt avoidance.** Background agents cannot show permission dialogs -- there is no terminal attached. So `shouldAvoidPermissionPrompts` is set to `true`, which causes the permission system to auto-deny rather than block. The exception is `bubble` mode: these agents surface prompts to the parent's terminal, so they can always show prompts regardless of sync/async status.

**Automated check ordering.** Background agents that *can* show prompts (bubble mode) set `awaitAutomatedChecksBeforeDialog`. This means the classifier and permission hooks run first; the user is only interrupted if automated resolution fails. For background work, waiting an extra second for the classifier is fine -- the user should not be interrupted unnecessarily.

**Tool permission scoping.** When `allowedTools` is provided, it replaces the session-level allow rules entirely. This prevents parent approvals from leaking through to scoped agents. But SDK-level permissions (from `--allowedTools` CLI flag) are preserved -- those represent the embedding application's explicit security policy and should apply everywhere.

### Step 6: Tool Resolution

```typescript
const resolvedTools = useExactTools
  ? availableTools
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools
```

Fork agents use `useExactTools: true`, which passes the parent's tool array through unchanged. This is not just convenience -- it is a cache optimization. Different tool definitions serialize differently (different permission modes produce different tool metadata), and any divergence in the tool block busts the prompt cache. Fork children need byte-identical prefixes.

For normal agents, `resolveAgentTools()` applies a layered filter:
- `tools: ['*']` means all tools; `tools: ['Read', 'Bash']` means only those
- `disallowedTools: ['Agent', 'FileEdit']` removes those from the pool
- Built-in agents and custom agents have different base disallowed tool sets
- Async agents get filtered through `ASYNC_AGENT_ALLOWED_TOOLS`

The result is that each agent type sees exactly the tools it should have. The Explore agent cannot call FileEdit. The Verification agent cannot call Agent (no recursive spawning from a verifier). Custom agents have a more restrictive default deny list than built-ins.

### Step 7: System Prompt

```typescript
const agentSystemPrompt = override?.systemPrompt
  ? override.systemPrompt
  : asSystemPrompt(
      await getAgentSystemPrompt(
        agentDefinition, toolUseContext,
        resolvedAgentModel, additionalWorkingDirectories, resolvedTools
      )
    )
```

Fork agents receive the parent's pre-rendered system prompt via `override.systemPrompt`. This is threaded from `toolUseContext.renderedSystemPrompt` -- the exact bytes the parent used in its last API call. Recomputing the system prompt via `getSystemPrompt()` could diverge. GrowthBook features might have transitioned from cold to warm between the parent's call and the child's. A single byte difference in the system prompt busts the entire prompt cache prefix.

For normal agents, `getAgentSystemPrompt()` calls the agent definition's `getSystemPrompt()` function, then enhances with environment details -- absolute paths, emoji guidance (Claude tends to over-use emojis in certain contexts), and model-specific instructions.

### Step 8: Abort Controller Isolation

```typescript
const agentAbortController = override?.abortController
  ? override.abortController
  : isAsync
    ? new AbortController()
    : toolUseContext.abortController
```

Three lines, three behaviors:

- **Override**: Used when resuming a backgrounded agent or for special lifecycle management. Takes precedence.
- **Async agents get a new, unlinked controller.** When the user presses Escape, the parent's abort controller fires. Async agents should survive this -- they are background work that the user chose to delegate. Their independent controller means they keep running.
- **Sync agents share the parent's controller.** Escape kills both. The child is blocking the parent; if the user wants to stop, they want to stop everything.

This is one of those decisions that seems obvious in retrospect but would be catastrophic if wrong. An async agent that aborts when the parent aborts would lose all its work every time the user pressed Escape to ask a follow-up question. A sync agent that ignored the parent's abort would leave the user staring at a frozen terminal.

### Step 9: Hook Registration

```typescript
if (agentDefinition.hooks && hooksAllowedForThisAgent) {
  registerFrontmatterHooks(
    rootSetAppState, agentId, agentDefinition.hooks,
    `agent '${agentDefinition.agentType}'`, true
  )
}
```

Agent definitions can declare their own hooks (PreToolUse, PostToolUse, etc.) in frontmatter. These hooks are scoped to the agent's lifecycle via the `agentId` -- they only fire for this agent's tool calls, and they are automatically cleaned up in the `finally` block when the agent terminates.

The `isAgent: true` flag (the final `true` parameter) converts `Stop` hooks to `SubagentStop` hooks. Sub-agents trigger `SubagentStop`, not `Stop`, so the conversion ensures the hooks fire at the right event.

Security matters here. When `strictPluginOnlyCustomization` is active for hooks, only plugin, built-in, and policy-settings agent hooks are registered. User-controlled agents (from `.claude/agents/`) have their hooks silently skipped. This prevents a malicious or misconfigured agent definition from injecting hooks that bypass security controls.

### Step 10: Skill Preloading

```typescript
const skillsToPreload = agentDefinition.skills ?? []
if (skillsToPreload.length > 0) {
  const allSkills = await getSkillToolCommands(getProjectRoot())
  // resolve names, load content, prepend to initialMessages
}
```

Agent definitions can specify `skills: ["my-skill"]` in their frontmatter. The resolution tries three strategies: exact match, prefix with the agent's plugin name (e.g., `"my-skill"` becomes `"plugin:my-skill"`), and suffix match on `":skillName"` for plugin-namespaced skills. The three-strategy resolution ensures that skill references work regardless of whether the agent author used the fully-qualified name, the short name, or the plugin-relative name.

Loaded skills become user messages prepended to the agent's conversation. This means the agent "reads" its skill instructions before seeing the task prompt -- the same mechanism used for slash commands in the main REPL, repurposed for automated skill injection. The skill content is loaded concurrently via `Promise.all()` to minimize startup latency when multiple skills are specified.

### Step 11: MCP Initialization

```typescript
const { clients: mergedMcpClients, tools: agentMcpTools, cleanup: mcpCleanup } =
  await initializeAgentMcpServers(agentDefinition, toolUseContext.options.mcpClients)
```

Agents can define their own MCP servers in frontmatter, additive to the parent's clients. Two forms are supported:

- **Reference by name**: `"slack"` looks up an existing MCP config and gets a shared, memoized client
- **Inline definition**: `{ "my-server": { command: "...", args: [...] } }` creates a new client that is cleaned up when the agent finishes

Only newly created (inline) clients are cleaned up. Shared clients are memoized at the parent level and persist beyond the agent's lifetime. This distinction prevents an agent from accidentally tearing down an MCP connection that other agents or the parent are still using.

The MCP initialization happens *after* hook registration and skill preloading but *before* context creation. This ordering matters: the MCP tools must be merged into the tool pool before `createSubagentContext()` snapshots the tools into the agent's options. Reordering these steps would mean the agent either has no MCP tools or has them but they are not in its tool pool.

### Step 12: Context Creation

```typescript
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,
  shareSetResponseLength: true,
  criticalSystemReminder_EXPERIMENTAL:
    agentDefinition.criticalSystemReminder_EXPERIMENTAL,
  contentReplacementState,
})
```

`createSubagentContext()` in `utils/forkedAgent.ts` assembles the new `ToolUseContext`. The key isolation decisions:

- **Sync agents share `setAppState`** with the parent. State changes (like permission approvals) are immediately visible to both. The user sees one coherent state.
- **Async agents get isolated `setAppState`**. The parent's copy is a no-op for the child's writes. But `setAppStateForTasks` reaches the root store -- the child can still update task state (progress, completion) that the UI observes.
- **Both share `setResponseLength`** for response metrics tracking.
- **Fork agents inherit `thinkingConfig`** for cache-identical API requests. Normal agents get `{ type: 'disabled' }` -- thinking (extended reasoning tokens) is disabled to control output costs. The parent pays for thinking; the children execute.

The `createSubagentContext()` function is worth examining for what it *isolates* versus what it *shares*. The isolation boundary is not all-or-nothing -- it is a carefully chosen set of shared and isolated channels:

| Concern | Sync Agent | Async Agent |
|---------|-----------|-------------|
| `setAppState` | Shared (parent sees changes) | Isolated (parent's copy is no-op) |
| `setAppStateForTasks` | Shared | Shared (task state must reach root) |
| `setResponseLength` | Shared | Shared (metrics need global view) |
| `readFileState` | Own cache | Own cache |
| `abortController` | Parent's | Independent |
| `thinkingConfig` | Fork: inherited / Normal: disabled | Fork: inherited / Normal: disabled |
| `messages` | Own array | Own array |

The asymmetry between `setAppState` (isolated for async) and `setAppStateForTasks` (always shared) is a key design decision. An async agent cannot push state changes to the parent's reactive store -- that would cause the parent's UI to jump unexpectedly. But the agent must still be able to update the global task registry, because that is how the parent knows the background agent has completed. The split channel solves both requirements.

### Step 13: Cache-Safe Params Callback

```typescript
if (onCacheSafeParams) {
  onCacheSafeParams({
    systemPrompt: agentSystemPrompt,
    userContext: resolvedUserContext,
    systemContext: resolvedSystemContext,
    toolUseContext: agentToolUseContext,
    forkContextMessages: initialMessages,
  })
}
```

This callback is consumed by background summarization. When an async agent is running, the summarization service can fork the agent's conversation -- using these exact params to construct a cache-identical prefix -- and generate periodic progress summaries without disturbing the main conversation. The params are "cache-safe" because they produce the same API request prefix the agent is using, maximizing cache hits.

### Step 14: The Query Loop

```typescript
try {
  for await (const message of query({
    messages: initialMessages,
    systemPrompt: agentSystemPrompt,
    userContext: resolvedUserContext,
    systemContext: resolvedSystemContext,
    canUseTool,
    toolUseContext: agentToolUseContext,
    querySource,
    maxTurns: maxTurns ?? agentDefinition.maxTurns,
  })) {
    // Forward API request starts for metrics
    // Yield attachment messages
    // Record to sidechain transcript
    // Yield recordable messages to caller
  }
}
```

The same `query()` function from Chapter 3 drives the sub-agent's conversation. The sub-agent's messages are yielded back to the caller -- either `AgentTool.call()` for sync agents (which iterates the generator inline) or `runAsyncAgentLifecycle()` for async agents (which consumes the generator in a detached async context).

Each yielded message is recorded to a sidechain transcript via `recordSidechainTranscript()` -- an append-only JSONL file per agent. This enables resume: if the session is interrupted, the agent can be reconstructed from its transcript. The recording is `O(1)` per message, appending only the new message with a reference to the previous UUID for chain continuity.

### Step 15: Cleanup

The `finally` block runs on normal completion, abort, or error. It is the most comprehensive cleanup sequence in the codebase:

```typescript
finally {
  await mcpCleanup()                              // Tear down agent-specific MCP servers
  clearSessionHooks(rootSetAppState, agentId)      // Remove agent-scoped hooks
  cleanupAgentTracking(agentId)                    // Prompt cache tracking state
  agentToolUseContext.readFileState.clear()         // Release file state cache memory
  initialMessages.length = 0                        // Release fork context (GC hint)
  unregisterPerfettoAgent(agentId)                 // Perfetto trace hierarchy
  clearAgentTranscriptSubdir(agentId)              // Transcript subdir mapping
  rootSetAppState(prev => {                        // Remove agent's todo entries
    const { [agentId]: _removed, ...todos } = prev.todos
    return { ...prev, todos }
  })
  killShellTasksForAgent(agentId, ...)             // Kill orphaned bash processes
}
```

Every subsystem the agent touched during its lifetime gets cleaned up. MCP connections, hooks, cache tracking, file state, perfetto tracing, todo entries, and orphaned shell processes. The comment about "whale sessions" spawning hundreds of agents is telling -- without this cleanup, each agent would leave small leaks that accumulate into measurable memory pressure over long sessions.

The `initialMessages.length = 0` line is a manual GC hint. For fork agents, `initialMessages` contains the parent's entire conversation history. Setting the length to zero releases those references so the garbage collector can reclaim the memory. In a session with a 200K-token context that spawns five fork children, that is a megabyte of duplicated message objects per child.

There is a lesson here about resource management in long-running agent systems. Each of the cleanup steps addresses a different kind of leak: MCP connections (file descriptors), hooks (memory in the app state store), file state caches (in-memory file content), Perfetto registrations (tracing metadata), todo entries (reactive state keys), and shell processes (OS-level processes). An agent interacts with many subsystems during its lifetime, and each subsystem must be notified when the agent is done. The `finally` block is the single place where all these notifications happen, and the generator protocol guarantees it runs. This is why the generator-based architecture is not just a convenience -- it is a correctness requirement.

### The Generator Chain

Before examining the built-in agent types, it is worth stepping back to see the structural pattern that makes all of this work. The entire sub-agent system is built on async generators. The chain flows:

```mermaid
graph TD
    subgraph Sync Path
        S1[AgentTool.call] -->|iterates inline| S2[runAgent generator]
        S2 -->|yield* query| S3[Child query loop]
        S3 -->|messages| S2
        S2 -->|final result| S1
        S1 -->|tool_result| S4[Parent query loop]
    end

    subgraph Async Path
        A1[AgentTool.call] -->|detaches| A2[runAsyncAgentLifecycle]
        A2 -->|wraps| A3[runAgent generator]
        A3 -->|yield* query| A4[Child query loop]
        A1 -->|immediate return| A5[Parent continues]
        A4 -->|completion| A6[Task notification]
        A6 -->|injected| A5
    end

    subgraph Fork Path
        F1[AgentTool.call] -->|detaches, forced async| F2[runAsyncAgentLifecycle]
        F2 -->|wraps| F3[runAgent generator]
        F3 -->|yield* query with\nbyte-identical prefix| F4[Child query loop]
        F1 -->|immediate return| F5[Parent continues]
        F4 -->|completion| F6[Task notification]
    end
```

This generator-based architecture enables four critical capabilities:

**Streaming.** Messages flow through the system incrementally. The parent (or the async lifecycle wrapper) can observe each message as it is produced -- updating progress indicators, forwarding metrics, recording transcripts -- without buffering the entire conversation.

**Cancellation.** Returning the async iterator triggers the `finally` block in `runAgent()`. The fifteen-step cleanup runs regardless of whether the agent completed normally, was aborted by the user, or threw an error. JavaScript's async generator protocol guarantees this.

**Backgrounding.** A sync agent that is taking too long can be backgrounded mid-execution. The iterator is handed off from the foreground (where `AgentTool.call()` is iterating it) to an async context (where `runAsyncAgentLifecycle()` takes over). The agent does not restart -- it continues from where it was.

**Progress tracking.** Each yielded message is an observation point. The async lifecycle wrapper uses these observation points to update the task state machine, compute progress percentages, and generate notifications when the agent completes.

---

## Built-In Agent Types

Built-in agents are registered via `getBuiltInAgents()` in `builtInAgents.ts`. The registry is dynamic -- which agents are available depends on feature flags, GrowthBook experiments, and the session's entrypoint type. Six built-in agents ship with the system, each optimized for a specific class of work.

### General-Purpose

The default agent when `subagent_type` is omitted and fork is not active. Full tool access, no CLAUDE.md omission, model determined by `getDefaultSubagentModel()`. Its system prompt positions it as a completion-oriented worker: "Complete the task fully -- don't gold-plate, but don't leave it half-done." It includes guidelines for search strategy (broad first, then narrow) and file creation discipline (never create files unless the task requires it).

This is the workhorse. When the model does not know what kind of agent it needs, it gets a general-purpose agent that can do everything the parent can do, minus spawning its own sub-agents. The "minus spawning" restriction is important: without it, a general-purpose child could spawn its own children, which could spawn theirs, creating an exponential fan-out that burns through API budget in seconds. The `Agent` tool is in the default disallowed list for good reason.

### Explore

A read-only search specialist. Uses Haiku (the cheapest, fastest model). Omits CLAUDE.md and git status. Has `FileEdit`, `FileWrite`, `NotebookEdit`, and `Agent` removed from its tool pool, enforced at both the tooling level and via a `=== CRITICAL: READ-ONLY MODE ===` section in its system prompt.

The Explore agent is the most aggressively optimized built-in because it is the most frequently spawned -- 34 million times per week across the fleet. It is marked as a one-shot agent (`ONE_SHOT_BUILTIN_AGENT_TYPES`), which means the agentId, SendMessage instructions, and usage trailer are skipped from its prompt, saving approximately 135 characters per invocation. At 34 million invocations, those 135 characters add up to roughly 4.6 billion characters per week of saved prompt tokens.

Availability is gated by the `BUILTIN_EXPLORE_PLAN_AGENTS` feature flag AND the `tengu_amber_stoat` GrowthBook experiment, which A/B tests the impact of removing these specialized agents.

### Plan

A software architect agent. Same read-only tool set as Explore but uses `'inherit'` for its model (same capability as the parent). Its system prompt guides it through a structured four-step process: Understand Requirements, Explore Thoroughly, Design Solution, Detail the Plan. It must end with a "Critical Files for Implementation" list.

The Plan agent inherits the parent's model because architecture requires the same reasoning capability as implementation. You do not want a Haiku-class model making design decisions that an Opus-class model will have to execute. The model mismatch would produce plans that the executing agent cannot follow -- or worse, plans that sound plausible but are subtly wrong in ways that only a more capable model would catch.

Same availability gate as Explore (`BUILTIN_EXPLORE_PLAN_AGENTS` + `tengu_amber_stoat`).

### Verification

The adversarial tester. Read-only tools, `'inherit'` model, always runs in background (`background: true`), displayed in red in the terminal. Its system prompt is the most elaborate of any built-in agent at approximately 130 lines.

What makes the Verification agent interesting is its anti-avoidance programming. The prompt explicitly lists excuses the model might reach for and instructs it to "recognize them and do the opposite." Every check must include a "Command run" block with actual terminal output -- no hand-waving, no "this should work." The agent must include at least one adversarial probe (concurrency, boundary, idempotency, orphan cleanup). And before reporting a failure, it must check whether the behavior is intentional or handled elsewhere.

The `criticalSystemReminder_EXPERIMENTAL` field injects a reminder after every tool result, reinforcing that this is verification-only. This is a guardrail against the model drifting from "verify" to "fix" -- a tendency that would undermine the entire purpose of an independent verification pass. Language models have a strong inclination to be helpful, and "helpful" in most contexts means "fix the problem." The Verification agent's entire value proposition depends on resisting that inclination.

The `background: true` flag means the Verification agent always runs asynchronously. The parent does not wait for verification results -- it continues working while the verifier probes in the background. When the verifier finishes, a notification appears with the results. This mirrors how human code review works: the developer does not stop coding while the reviewer reads their PR.

Availability is gated by the `VERIFICATION_AGENT` feature flag AND the `tengu_hive_evidence` GrowthBook experiment.

### Claude Code Guide

A documentation-fetching agent for questions about Claude Code itself, the Claude Agent SDK, and the Claude API. Uses Haiku, runs with `dontAsk` permission mode (no user prompts needed -- it only reads documentation), and has two hardcoded documentation URLs.

Its `getSystemPrompt()` is unique because it receives the `toolUseContext` and dynamically includes context about the project's custom skills, custom agents, configured MCP servers, plugin commands, and user settings. This lets it answer "how do I configure X?" by knowing what is already configured.

Excluded when the entrypoint is SDK (TypeScript, Python, or CLI), since SDK users are not asking Claude Code how to use Claude Code. They are building their own tools on top of it.

The Guide agent is an interesting case study in agent design because it is the only built-in agent whose system prompt is dynamic in a way that depends on the user's project. It needs to know what is configured to answer "how do I configure X?" effectively. This makes its `getSystemPrompt()` function more complex than the others, but the trade-off is worth it -- a documentation agent that does not know what the user has already set up gives worse answers than one that does.

### Statusline Setup

A specialized agent for configuring the terminal status line. Uses Sonnet, displayed in orange, limited to `Read` and `Edit` tools only. Knows how to convert shell PS1 escape sequences to shell commands, write to `~/.claude/settings.json`, and handle the `statusLine` command's JSON input format.

This is the most narrowly-scoped built-in agent -- it exists because status line configuration is a self-contained domain with specific formatting rules that would clutter a general-purpose agent's context. Always available, no feature gate.

The Statusline Setup agent illustrates an important principle: **sometimes a specialized agent is better than a general-purpose agent with more context.** A general-purpose agent given the status line documentation as context would probably configure it correctly. But it would also be more expensive (bigger model), slower (more context to process), and more likely to get confused by the interaction between status line syntax and the task at hand. A dedicated Sonnet agent with Read and Edit tools and a focused system prompt does the job faster, cheaper, and more reliably.

### The Worker Agent (Coordinator Mode)

Not in the `built-in/` directory but loaded dynamically when coordinator mode is active:

```typescript
if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
  const { getCoordinatorAgents } = require('../../coordinator/workerAgent.js')
  return getCoordinatorAgents()
}
```

The worker agent replaces all standard built-in agents in coordinator mode. It has a single type `"worker"` and full tool access. This simplification is deliberate -- when a coordinator is orchestrating workers, the coordinator decides what each worker does. The worker does not need the specialization of Explore or Plan; it needs the flexibility to do whatever the coordinator assigns.

---

## Fork Agents

Fork agents -- where the child inherits the parent's full conversation history, system prompt, and tool array for prompt cache exploitation -- are the subject of Chapter 9. The fork path triggers when the model omits `subagent_type` from the Agent tool call and the fork experiment is active. Every design decision in the fork system traces back to a single goal: byte-identical API request prefixes across parallel children, enabling 90% cache discounts on shared context.

---

## Agent Definitions from Frontmatter

Users and plugins can define custom agents by placing markdown files in `.claude/agents/`. The frontmatter schema supports the full range of agent configuration:

```yaml
---
description: "When to use this agent"
tools:
  - Read
  - Bash
  - Grep
disallowedTools:
  - FileWrite
model: haiku
permissionMode: dontAsk
maxTurns: 50
skills:
  - my-custom-skill
mcpServers:
  - slack
  - my-inline-server:
      command: node
      args: ["./server.js"]
hooks:
  PreToolUse:
    - command: "echo validating"
      event: PreToolUse
color: blue
background: false
isolation: worktree
effort: high
---

# My Custom Agent

You are a specialized agent for...
```

The markdown body becomes the agent's system prompt. The frontmatter fields map directly to the `AgentDefinition` interface that `runAgent()` consumes. The loading pipeline in `loadAgentsDir.ts` validates the frontmatter against `AgentJsonSchema`, resolves the source (user, plugin, or policy), and registers the agent in the available agents list.

Four sources of agent definitions exist, in priority order:

1. **Built-in agents** -- hardcoded in TypeScript, always available (subject to feature gates)
2. **User agents** -- markdown files in `.claude/agents/`
3. **Plugin agents** -- loaded via `loadPluginAgents()`
4. **Policy agents** -- loaded via organizational policy settings

When the model calls `Agent` with a `subagent_type`, the system resolves the name against this combined list, filtering by permission rules (deny rules for `Agent(AgentName)`) and by `allowedAgentTypes` from the tool spec. If the requested agent type is not found or is denied, the tool call fails with an error.

This design means that organizations can ship custom agents via plugins (a code review agent, a security audit agent, a deployment agent) and have them appear seamlessly alongside the built-in agents. The model sees them in the same list, with the same interface, and delegates to them the same way.

The power of frontmatter-defined agents is that they require zero TypeScript. A team lead who wants a "PR review" agent writes a markdown file with the right frontmatter, drops it in `.claude/agents/`, and it appears in every team member's agent list on their next session. The system prompt is the markdown body. The tool restrictions, model preference, and permission mode are declared in YAML. The `runAgent()` lifecycle handles everything else -- the same fifteen steps, the same cleanup, the same isolation guarantees.

This also means that agent definitions are version-controlled alongside the codebase. A repository can ship agents tailored to its architecture, conventions, and tooling. The agents evolve with the code. When the team adopts a new testing framework, the verification agent's prompt is updated in the same commit that adds the framework dependency.

There is one important security consideration: the trust boundary. User agents (from `.claude/agents/`) are user-controlled -- their hooks, MCP servers, and tool configurations are subject to `strictPluginOnlyCustomization` restrictions when those policies are active. Plugin agents and policy agents are admin-trusted and bypass these restrictions. Built-in agents are part of the Claude Code binary itself. The system tracks the `source` of each agent definition precisely so that security policies can distinguish between "the user wrote this" and "the organization approved this."

The `source` field is not just metadata -- it gates real behavior. When a plugin-only policy is active for MCP, user agent frontmatter that declares MCP servers is silently skipped (the MCP connections are not established). When a plugin-only policy is active for hooks, user agent frontmatter hooks are not registered. The agent still runs -- it just runs without the untrusted extensions. This is a principle of graceful degradation: the agent is useful even when its full capabilities are restricted by policy.

---

## Apply This: Designing Agent Types

The built-in agents demonstrate a pattern language for agent design. If you are building a system that spawns sub-agents -- whether using Claude Code's AgentTool directly or designing your own multi-agent architecture -- the design space breaks down into five dimensions.

### Dimension 1: What Can It See?

The combination of `omitClaudeMd`, git status stripping, and skill preloading controls the agent's awareness. Read-only agents see less (they do not need project conventions). Specialized agents see more (preloaded skills inject domain knowledge).

The key insight is that context is not free. Every token in the system prompt, user context, or conversation history costs money and displaces working memory. Claude Code strips CLAUDE.md from Explore agents not because those instructions are harmful, but because they are irrelevant -- and irrelevance at 34 million spawns per week becomes a line item on the infrastructure bill. When designing your own agent types, ask: "What does this agent need to know to do its job?" and strip everything else.

### Dimension 2: What Can It Do?

The `tools` and `disallowedTools` fields set hard boundaries. The Verification agent cannot edit files. The Explore agent cannot write anything. The General-Purpose agent can do everything except spawn sub-agents of its own.

Tool restrictions serve two purposes: **safety** (the Verification agent cannot accidentally "fix" what it finds, preserving its independence) and **focus** (an agent with fewer tools spends less time deciding which tool to use). The pattern of combining tool-level restrictions with system prompt guidance (Explore's `=== CRITICAL: READ-ONLY MODE ===`) is defense in depth -- the tools enforce the boundary mechanically, and the prompt explains *why* the boundary exists so the model does not waste turns trying to work around it.

### Dimension 3: How Does It Interact with the User?

The `permissionMode` and `canShowPermissionPrompts` settings determine whether the agent asks for permission, auto-denies, or bubbles prompts to the parent's terminal. Background agents that cannot interrupt the user must either work within pre-approved boundaries or bubble.

The `awaitAutomatedChecksBeforeDialog` setting is a nuance worth understanding. Background agents that *can* show prompts (bubble mode) wait for the classifier and permission hooks to run before interrupting the user. This means the user is only interrupted for genuinely ambiguous permissions -- not for things the automated system could have resolved. In a multi-agent system where five background agents are running simultaneously, this is the difference between a usable interface and a permission-prompt barrage.

### Dimension 4: How Does It Relate to the Parent?

Sync agents block the parent and share its state. Async agents run independently with their own abort controller. Fork agents inherit the full conversation context. The choice shapes both the user experience (does the parent wait?) and the system behavior (does Escape kill the child?).

The abort controller decision in Step 8 crystallizes this: sync agents share the parent's controller (Escape kills both), async agents get their own (Escape leaves them running). Fork agents go further -- they inherit the parent's system prompt, tool array, and message history to maximize prompt cache sharing. Each relationship type has a clear use case: sync for sequential delegation ("do this then I'll continue"), async for parallel work ("do this while I do something else"), and fork for context-heavy delegation ("you know everything I know, now go handle this part").

### Dimension 5: How Expensive Is It?

The model choice, thinking config, and context size all contribute to cost. Haiku for cheap read-only work. Sonnet for moderate tasks. Inherit-from-parent for tasks requiring the parent's reasoning capability. Thinking is disabled for non-fork agents to control output token costs -- the parent pays for reasoning; the children execute.

The economic dimension is often an afterthought in multi-agent system design, but it is central to Claude Code's architecture. An Explore agent that used Opus instead of Haiku would work fine for any individual invocation. But at 34 million invocations per week, the model choice is a multiplicative cost factor. The one-shot optimization that saves 135 characters per Explore invocation translates to 4.6 billion characters per week of saved prompt tokens. These are not micro-optimizations -- they are the difference between a viable product and an unaffordable one.

### The Unified Lifecycle

The `runAgent()` lifecycle implements all five dimensions through its fifteen steps, assembling a unique execution environment for each agent type from the same set of building blocks. The result is a system where spawning a sub-agent is not "run another copy of the parent." It is the creation of a precisely-scoped, resource-controlled, isolated execution context -- tailored to the work at hand, and cleaned up completely when the work is done.

The architectural elegance is in the uniformity. Whether the agent is a Haiku-powered read-only searcher or an Opus-powered fork child with full tool access and bubble permissions, it flows through the same fifteen steps. The steps do not branch based on agent type -- they parameterize. Model resolution picks the right model. Context preparation picks the right file state. Permission isolation picks the right mode. The agent type is not encoded in control flow; it is encoded in configuration. And that is what makes the system extensible: adding a new agent type means writing a definition, not modifying the lifecycle.

### The Design Space Summarized

The six built-in agents cover a spectrum:

| Agent | Model | Tools | Context | Sync/Async | Purpose |
|-------|-------|-------|---------|------------|---------|
| General-Purpose | Default | All | Full | Either | Workhorse delegation |
| Explore | Haiku | Read-only | Stripped | Sync | Fast, cheap search |
| Plan | Inherit | Read-only | Stripped | Sync | Architecture design |
| Verification | Inherit | Read-only | Full | Always async | Adversarial testing |
| Guide | Haiku | Read + Web | Dynamic | Sync | Documentation lookup |
| Statusline | Sonnet | Read + Edit | Minimal | Sync | Config task |

No two agents make the same choices across all five dimensions. Each is optimized for its specific use case. And the `runAgent()` lifecycle handles all of them through the same fifteen steps, parameterized by the agent definition. This is the power of the architecture: the lifecycle is a universal machine, and the agent definitions are the programs that run on it.

The next chapter examines fork agents in depth -- the prompt cache exploitation mechanism that makes parallel delegation economically viable. Chapter 10 then follows with the orchestration layer: how async agents report progress through the task state machine, how the parent retrieves results, and how the coordinator pattern orchestrates dozens of agents working toward a single goal. If this chapter was about *creating* agents, Chapter 9 is about making them cheap, and Chapter 10 is about *managing* them.
