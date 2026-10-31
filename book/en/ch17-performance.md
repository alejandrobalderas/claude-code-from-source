# Chapter 17: Performance -- Every Millisecond and Token Counts

## The Senior Engineer's Playbook

Performance optimization in an agentic system is not one problem. It is five:

1. **Startup latency** -- the time from keystroke to first useful output. Users abandon tools that feel slow to launch.
2. **Token efficiency** -- the fraction of the context window consumed by useful content versus overhead. The context window is the most constrained resource.
3. **API cost** -- the dollar amount per turn. Prompt caching can reduce this by 90%, but only if the system preserves cache stability across turns.
4. **Rendering throughput** -- the frames per second during streaming output. Chapter 13 covered the rendering architecture; this chapter covers the performance measurements and optimizations that keep it fast.
5. **Search speed** -- the time to find a file in a 270,000-path codebase on every keystroke.

Claude Code attacks all five with techniques ranging from the obvious (memoization) to the subtle (26-bit bitmaps for pre-filtering fuzzy search). A note on methodology: these are not theoretical optimizations. Claude Code ships with 50+ startup profiling checkpoints, sampled at 100% of internal users and 0.5% of external users. Every optimization below was motivated by data from this instrumentation, not by intuition.

---

## Saving Milliseconds at Startup

### Module-Level I/O Parallelism

The entry point `main.tsx` deliberately violates "no side effects at module scope":

```typescript
profileCheckpoint('main_tsx_entry');
startMdmRawRead();       // fires plutil/reg-query subprocesses
startKeychainPrefetch();  // fires both macOS keychain reads in parallel
```

Two macOS keychain entries would otherwise cost ~65ms of sequential synchronous spawns. By launching both as fire-and-forget promises at the module level, they execute in parallel with ~135ms of module loading during which the CPU would otherwise be idle.

### API Preconnection

`apiPreconnect.ts` fires a `HEAD` request to the Anthropic API during initialization, overlapping the TCP+TLS handshake (100-200ms) with setup work. In interactive mode, the overlap is unbounded -- the connection warms while the user types. The request fires after `applyExtraCACertsFromConfig()` and `configureGlobalAgents()` so the warmed connection uses the correct transport configuration.

### Fast-Path Dispatch and Deferred Imports

The CLI entry point contains early-return paths for specialized subcommands -- `claude mcp` never loads the React REPL, `claude daemon` never loads the tool system. Heavy modules are loaded via dynamic `import()` only when needed: OpenTelemetry (~400KB + ~700KB gRPC), event logging, error dialogs, upstream proxy. `LazySchema` defers Zod schema construction to first validation, pushing the cost past startup.

---

## Saving Tokens in the Context Window

### Slot Reservation: 8K Default, 64K Escalation

The most impactful single optimization:

The default output slot reservation is 8,000 tokens, escalating to 64,000 on truncation. The API reserves `max_output_tokens` of capacity for the model's response. The default SDK value is 32K-64K, but production data shows p99 output length is 4,911 tokens. The default over-reserves by 8-16x, wasting 24,000-59,000 tokens per turn. Claude Code caps at 8K and retries at 64K on the rare truncation (<1% of requests). For a 200K window, this is a 12-28% improvement in usable context -- for free.

### Tool Result Budgeting

| Limit | Value | Purpose |
|-------|-------|---------|
| Per-tool characters | 50,000 | Results persisted to disk when exceeded |
| Per-tool tokens | 100,000 | ~400KB text upper bound |
| Per-message aggregate | 200,000 chars | Prevents N parallel tools from blowing the budget in one turn |

The per-message aggregate is the key insight. Without it, "read all files in src/" could produce 10 parallel reads each returning 40K characters.

### Context Window Sizing

The default 200K-token window is expandable to 1M via the `[1m]` suffix on model names or experiment treatment. When usage approaches the limit, a 4-layer compaction system progressively summarizes older content. Token counting is anchored on the API's actual `usage` field, not client-side estimation -- accounting for prompt caching credits, thinking tokens, and server-side transformations.

---

## Saving Money on API Calls

### The Prompt Cache Architecture

```mermaid
graph LR
    subgraph "Prompt Structure (stable first, volatile last)"
        A["CLI identity, tool instructions,<br/>code style rules<br/><b>Globally cacheable</b>"]
        B["__DYNAMIC_BOUNDARY__"]
        C["Date, memory files,<br/>CLAUDE.md, output prefs<br/><b>Per-session</b>"]
        D["Conversation history<br/><b>Grows each turn</b>"]
        E["Tool results<br/><b>Volatile</b>"]
    end

    A --> B --> C --> D --> E

    HIT["Cache hit<br/>90% discount"] -.->|"spans stable prefix"| A
    MISS["Cache miss<br/>full price"] -.->|"everything after change"| E

    style A fill:#c8e6c9
    style B fill:#fff9c4
    style E fill:#ffcdd2
```

Anthropic's prompt cache operates on exact prefix matching. If a single token changes mid-prefix, everything after is a cache miss. Claude Code structures the entire prompt so stable parts come first and volatile parts come last.

When `shouldUseGlobalCacheScope()` returns true, system prompt entries before the dynamic boundary get `scope: 'global'` -- two users running the same Claude Code version share the prefix cache. Global scope is disabled when MCP tools are present, since MCP schemas are per-user.

### Sticky Latch Fields

Five boolean fields use a "sticky-on" pattern -- once true, they remain true for the session:

| Latch Field | What It Prevents |
|-------------|-----------------|
| `promptCache1hEligible` | Mid-session overage flip changing cache TTL |
| `afkModeHeaderLatched` | Shift+Tab toggles busting cache |
| `fastModeHeaderLatched` | Cooldown enter/exit double-busting cache |
| `cacheEditingHeaderLatched` | Mid-session config toggles busting cache |
| `thinkingClearLatched` | Flipping thinking mode after confirmed cache miss |

Each corresponds to a header or parameter that, if changed mid-session, would bust ~50,000-70,000 tokens of cached prompt. The latches sacrifice mid-session toggling to preserve the cache.

### Memoized Session Date

```typescript
const getSessionStartDate = memoize(getLocalISODate)
```

Without this, the date would change at midnight, busting the entire cached prefix. A stale date is cosmetic; a cache bust reprocesses the entire conversation.

### Section Memoization

System prompt sections use a two-tier cache. Most content uses `systemPromptSection(name, compute)`, cached until `/clear` or `/compact`. The nuclear option `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` recomputes every turn -- the naming convention forces developers to document WHY cache-breaking is necessary.

---

## Saving CPU in Rendering

Chapter 13 covered the rendering architecture in depth -- the packed typed arrays, pool-based interning, double buffering, and cell-level diffing. Here we focus on the performance measurements and adaptive behaviors that keep it fast.

The terminal renderer throttles at 60fps via `throttle(deferredRender, FRAME_INTERVAL_MS)`. When the terminal is blurred, the interval doubles to 30fps. Scroll drain frames run at quarter interval for maximum scroll speed. This adaptive throttling ensures rendering never consumes more CPU than necessary.

The React Compiler (`react/compiler-runtime`) auto-memoizes component renders throughout the codebase. Manual `useMemo` and `useCallback` are error-prone; the compiler gets it right by construction. Pre-allocated frozen objects (`Object.freeze()`) eliminate allocations for common render-path values -- one allocation saved per frame in alt-screen mode compounds over thousands of frames.

For the full rendering pipeline details -- the `CharPool`/`StylePool`/`HyperlinkPool` interning system, the blit optimization, the damage rectangle tracking, the OffscreenFreeze component -- see Chapter 13.

---

## Saving Memory and Time in Search

The fuzzy file search runs on every keystroke, searching 270,000+ paths. Three optimization layers keep it under a few milliseconds.

### The Bitmap Pre-Filter

Every indexed path gets a 26-bit bitmap of which lowercase letters it contains:

```typescript
// Pseudocode — illustrates the 26-bit bitmap concept
function buildCharBitmap(filepath: string): number {
  let mask = 0
  for (const ch of filepath.toLowerCase()) {
    const code = ch.charCodeAt(0)
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97)
  }
  return mask  // Each bit represents presence of a-z
}
```

At search time: `if ((charBits[i] & needleBitmap) !== needleBitmap) continue`. Any path missing a query letter fails instantly -- one integer comparison, no string operations. Rejection rate: ~10% for broad queries like "test," 90%+ for queries with rare letters. Cost: 4 bytes per path, ~1MB for 270,000 paths.

### Score-Bound Rejection and Fused indexOf Scan

Paths surviving the bitmap face a score ceiling check before the expensive boundary/camelCase scoring. If the best-case score cannot beat the current top-K threshold, the path is skipped.

The actual matching fuses position finding with gap/consecutive bonus computation using `String.indexOf()`, which is SIMD-accelerated in both JSC (Bun) and V8 (Node). The engine's optimized search is significantly faster than manual character loops.

### Async Indexing with Partial Queryability

For large codebases, `loadFromFileListAsync()` yields to the event loop every ~4ms of work (time-based, not count-based -- adapting to machine speed). It returns two promises: `queryable` (resolves on first chunk, enabling immediate partial results) and `done` (full index complete). The user can start searching within 5-10ms of the file list becoming available.

The yield check uses `(i & 0xff) === 0xff` -- a branchless modulo-256 to amortize the cost of `performance.now()`.

---

## The Memory Relevance Side-Query

One optimization sits at the intersection of token efficiency and API cost. As described in Chapter 11, the memory system uses a lightweight Sonnet model call -- not the main Opus model -- to select which memory files to include. The cost (256 max output tokens on a fast model) is negligible compared to the tokens saved by not including irrelevant memory files. A single irrelevant 2,000-token memory costs more in wasted context than the side query costs in API calls.

---

## Speculative Tool Execution

The `StreamingToolExecutor` begins executing tools as they stream in, before the full response completes. Read-only tools (Glob, Grep, Read) can execute in parallel; write tools require exclusive access. The `partitionToolCalls()` function groups consecutive safe tools into batches: [Read, Read, Grep, Edit, Read, Read] becomes three batches -- [Read, Read, Grep] concurrent, [Edit] serial, [Read, Read] concurrent.

Results are always yielded in the original tool order for deterministic model reasoning. A sibling abort controller kills parallel subprocesses when a Bash tool errors, preventing resource waste.

---

## Streaming and the Raw API

Claude Code uses the raw streaming API instead of the SDK's `BetaMessageStream` helper. The helper calls `partialParse()` on every `input_json_delta` -- O(n^2) in tool input length. Claude Code accumulates raw strings and parses once when the block is complete.

A streaming watchdog (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, default 90 seconds) aborts and retries if no chunks arrive, with fallback to non-streaming `messages.create()` on proxy failure.

---

## Apply This: Performance for Agentic Systems

**Audit your context window budget.** The gap between your `max_output_tokens` reservation and your actual p99 output length is wasted context. Set a tight default and escalate on truncation.

**Design for cache stability.** Every field in your prompt is stable or volatile. Put stable first, volatile last. Treat any mid-conversation change to the stable prefix as a bug with a dollar cost.

**Parallelize startup I/O.** Module loading is CPU-bound. Keychain reads and network handshakes are I/O-bound. Launch I/O before imports.

**Use bitmap pre-filters for search.** A cheap pre-filter rejecting 10-90% of candidates before expensive scoring is a significant win at 4 bytes per entry.

**Measure where it matters.** Claude Code has 50+ startup checkpoints, sampled at 100% internally and 0.5% externally. Performance work without measurement is guesswork.

---

A final observation: most of these optimizations are not algorithmically sophisticated. Bitmap pre-filters, circular buffers, memoization, interning -- these are CS fundamentals. The sophistication is in knowing where to apply them. The startup profiler tells you where the milliseconds are. The API usage field tells you where the tokens are. The cache hit rate tells you where the money is. Measurement first, optimization second, always.
