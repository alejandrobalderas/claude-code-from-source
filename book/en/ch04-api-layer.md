# Chapter 4: Talking to Claude -- The API Layer

Chapter 3 established where state lives and how the two tiers communicate. Now we follow what happens when that state is put to use: the system needs to talk to a language model. Everything in Claude Code -- the bootstrap sequence, the state system, the permission framework -- exists to serve this moment.

This layer handles more failure modes than any other part of the system. It must route through four cloud providers via a single transparent interface. It must construct system prompts with byte-level awareness of how the server's prompt cache works, because a single misplaced section can bust a cache worth 50,000+ tokens. It must stream responses with active failure detection, because TCP connections die silently. And it must maintain session-stable invariants so that mid-conversation changes to feature flags do not cause invisible performance cliffs.

Let us trace a single API call from start to finish.

```mermaid
sequenceDiagram
    participant QL as Query Loop
    participant CF as Client Factory
    participant SP as System Prompt Builder
    participant BH as Beta Headers
    participant MN as Message Normalizer
    participant API as Claude API
    participant WD as Watchdog
    participant RP as Response Processor

    QL->>CF: getAnthropicClient()
    CF->>CF: Provider dispatch + auth
    CF-->>QL: Authenticated client

    QL->>SP: Build system prompt
    SP->>SP: Static sections + BOUNDARY + dynamic sections
    SP-->>QL: Prompt blocks with cache_control

    QL->>BH: Assemble beta headers
    BH->>BH: Evaluate sticky latches
    BH-->>QL: Session-stable header set

    QL->>MN: Normalize messages
    MN->>MN: Pair tool_use/result, strip excess media
    MN-->>QL: Clean message array

    QL->>API: Stream request
    API-->>WD: Start idle timer (90s)
    API-->>RP: SSE events stream back
    WD-->>WD: Reset timer on each chunk
    RP-->>QL: StreamEvents + AssistantMessage
```

---

## The Multi-Provider Client Factory

The `getAnthropicClient()` function is the single factory for all model communication. It returns an Anthropic SDK client configured for whichever provider the deployment targets:

```mermaid
graph LR
    F["getAnthropicClient()"] --> D["Direct API<br/>API key or OAuth"]
    F --> B["AWS Bedrock<br/>AWS credentials"]
    F --> V["Google Vertex AI<br/>Google Auth"]
    F --> A["Azure Foundry<br/>Azure credentials"]
    D & B & V & A --> SDK["Anthropic SDK Client"]
    SDK --> CL["callModel()"]
```

The dispatch is entirely environment-variable driven, evaluated in a fixed priority order. All four provider-specific SDK classes are cast to `Anthropic` via `as unknown as Anthropic`. The comment in the source is refreshingly honest: "we have always been lying about the return type." This deliberate type erasure means every consumer sees a uniform interface. The rest of the codebase never branches on provider.

Each provider SDK is dynamically imported -- `AnthropicBedrock`, `AnthropicFoundry`, `AnthropicVertex` are heavy modules with their own dependency trees. The dynamic import ensures unused providers never load.

Provider selection is determined at startup and stored in bootstrap `STATE`. The query loop never checks which provider is active. Switching from Direct API to Bedrock is a configuration change, not a code change.

### The buildFetch Wrapper

Every outbound fetch gets wrapped to inject an `x-client-request-id` header -- a UUID generated per request. When a request times out, the server never assigns a request ID to the response. Without the client-side ID, the API team cannot correlate the timeout with server-side logs. This header bridges that gap. It is only sent to first-party Anthropic endpoints -- third-party providers might reject unknown headers.

---

## System Prompt Construction

The system prompt is the most cache-sensitive artifact in the entire system. Claude's API provides server-side prompt caching: identical prompt prefixes across requests can be cached, saving both latency and cost. A 200K-token conversation might have 50-70K tokens that are identical to the previous turn. Busting that cache forces the server to re-process all of it.

### The Dynamic Boundary Marker

The prompt is built as an array of string sections with a critical dividing line:

```mermaid
flowchart TD
    subgraph Static["Static Content (cacheScope: global)"]
        direction TB
        S1["Identity & intro"]
        S2["System behavior rules"]
        S3["Doing tasks guidance"]
        S4["Actions guidance"]
        S5["Tool usage instructions"]
        S6["Tone & style"]
        S7["Output efficiency"]
    end

    B["=== DYNAMIC BOUNDARY ==="]

    subgraph Dynamic["Dynamic Content (per-session)"]
        direction TB
        D1["Session guidance"]
        D2["Memory (CLAUDE.md)"]
        D3["Environment info"]
        D4["Language preference"]
        D5["MCP instructions (DANGEROUS: uncached)"]
        D6["Output style"]
    end

    Static --> B --> Dynamic

    style B fill:#f99,stroke:#333,color:#000
    style Static fill:#dfd,stroke:#333
    style Dynamic fill:#ddf,stroke:#333
```

Everything before the boundary is identical across sessions, users, and organizations -- it gets the highest tier of server-side caching. Everything after contains user-specific content and drops to per-session caching.

The naming convention for sections is deliberately loud. Adding a new section requires choosing between `systemPromptSection` (safe, cached) and `DANGEROUS_uncachedSystemPromptSection` (cache-breaking, requires a reason string). The `_reason` parameter is unused at runtime but serves as mandatory documentation -- every cache-breaking section carries its justification in the source code.

### The 2^N Problem

A comment in `prompts.ts` explains why conditional sections must go after the boundary:

> Each conditional here is a runtime bit that would otherwise multiply the Blake2b prefix hash variants (2^N).

Every boolean condition before the boundary doubles the number of unique global cache entries. Three conditionals create 8 variants; five create 32. The static sections are deliberately unconditional. Compile-time feature flags (resolved by the bundler) are acceptable before the boundary. Runtime checks (is this Haiku? does the user have auto mode?) must go after.

This is the kind of constraint that is invisible until you violate it. A well-intentioned engineer adding a user-setting-gated section before the boundary could silently fragment the global cache and double the fleet's prompt processing costs.

---

## Streaming

### Raw SSE Over SDK Abstractions

The streaming implementation uses the raw `Stream<BetaRawMessageStreamEvent>` rather than the SDK's higher-level `BetaMessageStream`. The reason: `BetaMessageStream` calls `partialParse()` on every `input_json_delta` event. For tool calls with large JSON inputs (file edits with hundreds of lines), this re-parses the growing JSON string from scratch on every chunk -- O(n^2) behavior. Claude Code handles tool input accumulation itself, so the partial parsing is pure waste.

### The Idle Watchdog

TCP connections can die without notification. The server may crash, a load balancer may silently drop the connection, or a corporate proxy may time out. The SDK's request timeout only covers the initial fetch -- once HTTP 200 arrives, the timeout is satisfied. If the streaming body stops, nothing catches it.

The watchdog: a `setTimeout` that resets on every received chunk. If no chunks arrive for 90 seconds, the stream is aborted and the system falls back to a non-streaming retry. A warning fires at the 45-second mark. When the watchdog fires, it logs the event with the client request ID for correlation.

### Non-Streaming Fallback

When streaming fails mid-response (network error, stall, truncation), the system falls back to a synchronous `messages.create()` call. This handles proxy failures where the proxy returns HTTP 200 with a non-SSE body, or truncates the SSE stream partway through.

The fallback can be disabled when streaming tool execution is active, since a fallback would re-execute the entire request and potentially run tools twice.

---

## Prompt Cache System

### Three Tiers

Prompt caching operates at three levels:

**Ephemeral cache** (default): Per-session caching with a server-defined TTL (~5 minutes). All users get this.

**1-hour TTL**: Eligible users get extended caching. Eligibility is determined by subscription status and latched in bootstrap state -- the `promptCache1hEligible` sticky latch from Chapter 3 ensures a mid-session overage flip does not change the TTL.

**Global scope**: System prompt cache entries get cross-session, cross-organization sharing. The static portions of the prompt are identical for all Claude Code users, so a single cached copy serves everyone. Global scope is disabled when MCP tools are present, because MCP tool definitions are user-specific and would fragment the cache into millions of unique prefixes.

### The Sticky Latches in Action

The five sticky latches from Chapter 3 are evaluated here, during request construction. Each latch starts as `null` and, once set to `true`, remains `true` for the session. The comment above the latch block is precise: "Sticky-on latches for dynamic beta headers. Each header, once first sent, keeps being sent for the rest of the session so mid-session toggles don't change the server-side cache key and bust ~50-70K tokens."

See Chapter 3, Section 3.1 for the full explanation of the latch pattern, the five specific latches, and why always-send-all-headers is not the right solution.

---

## The queryModel Generator

The `queryModel()` function is an async generator (~700 lines) that orchestrates the entire API call lifecycle. It yields `StreamEvent`, `AssistantMessage`, and `SystemAPIErrorMessage` objects.

The request assembly follows a carefully ordered sequence:

1. **Kill switch check** -- safety valve for the most expensive model tier
2. **Beta header assembly** -- model-specific, with sticky latches applied
3. **Tool schema building** -- parallel via `Promise.all()`, deferred tools excluded until discovered
4. **Message normalization** -- repair orphaned tool_use/tool_result mismatches, strip excess media, remove stale blocks
5. **System prompt block construction** -- split at the dynamic boundary, assign cache scopes
6. **Retry-wrapped streaming** -- handles 529 (overloaded), model fallback, thinking downgrade, OAuth refresh

### Output Token Cap

The default output cap is 8,000 tokens, not the typical 32K or 64K. Production data showed that p99 output is 4,911 tokens -- standard limits over-reserve by 8-16x. When a response hits the cap (<1% of requests), it gets one clean retry at 64K. This saves significant cost at fleet scale.

### Error Handling and Retry

The `withRetry()` function is itself an async generator that yields `SystemAPIErrorMessage` events so the UI can display retry status. Retry strategies:

- **529 (overloaded)**: Wait and retry, optionally downgrading fast mode
- **Model fallback**: Primary model fails, try a fallback (e.g., Opus to Sonnet)
- **Thinking downgrade**: Context window overflow triggers reduced thinking budget
- **OAuth 401**: Refresh token and retry once

The generator pattern means retry progress ("Server overloaded, retrying in 5s...") appears as a natural part of the event stream, not as a side-channel notification.

---

## Apply This

**Treat prompt caching as an architectural constraint, not a feature toggle.** Most LLM applications "turn on" caching. Claude Code treats it as a design constraint that shapes prompt ordering, section memoization, header latching, and configuration management. The difference between a well-structured prompt (cache hit on 50K tokens) and a poorly-structured one (full reprocessing every turn) is the single largest cost lever in the system.

**Use the DANGEROUS naming convention for costly escape hatches.** When a codebase has an invariant that is easy to violate accidentally, naming the escape hatch with a loud prefix does three things: makes violations visible in code review, forces documentation (the required reason parameter), and creates psychological friction toward the safe default. This generalizes beyond caching to any operation with invisible cost.

**Build streaming with a watchdog, not just a timeout.** The SDK's request timeout satisfies on HTTP 200, but the response body can stop arriving at any point. A `setTimeout` that resets on every chunk catches this. The non-streaming fallback handles proxy failure modes (HTTP 200 with non-SSE body, mid-stream truncation) that are more common than you expect in corporate environments.

**Make retry strategies yield-based, not exception-based.** By making the retry wrapper an async generator that yields status events, the caller displays retry progress as a natural part of the event stream. The model fallback pattern (Opus fails, try Sonnet) is particularly useful for production resilience.

**Separate the fast path from the full pipeline.** Not every API call needs tool search, advisor integration, thinking budgets, and streaming infrastructure. Claude Code's `queryHaiku()` function provides a streamlined path for internal operations (compaction, classification) that skips all agentic concerns. A separate function with a simplified interface prevents accidental complexity leakage.

---

## Looking Ahead

The API layer sits at the foundation of everything that follows. Chapter 5 will show how the query loop uses the streaming response to drive tool execution -- including how tools begin executing before the model finishes its response. Chapter 6 will explain how the compaction system preserves cache efficiency when conversations approach the context limit. Chapter 7 will show how each agent thread gets its own message array and request chain.

All of those systems inherit the constraints established here: cache stability as an architectural invariant, provider transparency through the client factory, and session-stable configuration through the latch system. The API layer does not just send requests -- it defines the rules by which every other system operates.
