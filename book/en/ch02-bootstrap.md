# Chapter 2: Starting Fast -- The Bootstrap Pipeline

If Chapter 1 gave you the map of Claude Code's architecture, this chapter gives you the route it takes to reach a working state. Every component from the six abstractions -- the query loop, the tool system, the state layers, hooks, memory -- must be initialized before the user sees a cursor. The budget for all of it: 300 milliseconds.

Three hundred milliseconds is the threshold where humans perceive a tool as instant. Cross it, and the CLI feels sluggish. Miss it by a lot, and developers stop using it. Everything in this chapter exists to stay under that line.

Bootstrap must accomplish four things: validate the environment, establish security boundaries, configure the communication layer, and render the UI. It must do all four in under 300ms. The architectural insight is that these four jobs can be partially overlapped, carefully ordered, and aggressively pruned to fit inside a budget that feels impossible for a system this complex.

A note on methodology: the timestamps in this chapter are approximate, derived from the codebase's own profiling checkpoints. They represent typical warm-start timings on modern hardware. Cold starts are slower. The absolute numbers matter less than the relative structure: which operations overlap, which block, and which are deferred.

---

## The Shape of the Pipeline

The startup pipeline lives in five files, executed in sequence. Each file narrows the scope of what the system needs to do next:

```mermaid
flowchart TD
    CLI["cli.tsx<br/>Fast-path dispatch"] -->|not a fast path| Main["main.tsx<br/>Module-level I/O (subprocess, keychain)"]
    Main --> Init["init.ts<br/>Parse args, trust boundary, init()"]
    Init --> Setup["setup.ts<br/>Commands, agents, hooks, plugins"]
    Setup --> Launch["replLauncher.ts<br/>Seven launch paths converge"]
    Launch --> REPL["Running REPL"]

    style CLI fill:#f9f,stroke:#333
    style REPL fill:#9f9,stroke:#333
```

Each file does the minimum work necessary before passing control to the next. `cli.tsx` tries to exit before importing anything heavy. `main.tsx` fires slow operations as side effects during import evaluation. `init.ts` resolves configuration and establishes the trust boundary. `setup.ts` registers capabilities. `replLauncher.ts` picks the right entry point and starts the UI.

Three parallelism strategies make this fast:

1. **Module-level subprocess dispatch.** Fire keychain and MDM reads as side effects *during import evaluation*. The subprocesses run while the remaining ~135ms of static imports load.
2. **Promise parallelism in setup.** Socket binding, hook snapshotting, command loading, and agent definition loading all run concurrently.
3. **Post-render deferred prefetches.** Everything the user does not need before typing their first message -- git status, model capabilities, AWS credentials -- runs after the prompt is visible.

A fourth strategy is less visible but equally important: **dynamic imports to defer module evaluation**. The codebase uses `await import('./module.js')` in at least a dozen places to avoid loading code until it is needed. OpenTelemetry (400KB + 700KB gRPC) loads only when telemetry initializes. React components load only when rendering. Each dynamic import trades cold-path latency (first use triggers module evaluation) for hot-path speed (startup does not pay for modules it might never use).

---

## Phase 0: Fast-Path Dispatch (cli.tsx)

The first file the process enters, `cli.tsx`, has one job: determine whether the full bootstrap pipeline is needed at all. Many invocations -- `claude --version`, `claude --help`, `claude mcp list` -- need a specific answer and nothing else. Loading React, initializing telemetry, reading the keychain, and setting up the tool system would be pure waste.

The pattern is: check `argv`, dynamically import only the handler you need, and exit before the rest of the system loads.

```typescript
// Pseudocode for the fast-path pattern
if (args.length === 1 && args[0] === '--version') {
  const { printVersion } = await import('./commands/version.js')
  await printVersion()
  process.exit(0)
}
```

There are roughly a dozen fast paths covering version, help, configuration, MCP server management, and update checks. The specifics do not matter -- the pattern does. Each path dynamically imports exactly one module, calls one function, and exits. The rest of the codebase never loads.

This is the first instance of a principle that recurs throughout bootstrap: **do less by knowing more about intent**. The argv array reveals the user's intent. If the intent is narrow, the execution path should be narrow too.

If no fast path matches, `cli.tsx` falls through to the full `main.tsx` import, and the real startup begins.

---

## Phase 1: Module-Level I/O (main.tsx)

When `main.tsx` is imported, its module-level side effects fire during evaluation -- before any function in the file is called. This is the most performance-critical technique in the entire bootstrap:

```typescript
// These run at import time, not at call time
const mdmPromise = startMDMSubprocess()
const keychainPromise = readKeychainCredentials()
```

While the JavaScript engine evaluates the rest of `main.tsx` and its transitive imports (~138ms of module evaluation), these two promises are already in flight. The MDM (Mobile Device Management) subprocess checks organizational security policies. The keychain read fetches stored credentials. Both are I/O-bound operations that would otherwise serialize on the critical path.

The insight: module evaluation is not idle time -- it is time you can overlap with I/O. By the time `main.tsx`'s exported functions are first called, these promises are often already resolved.

This technique requires suppressing ESLint's top-level-await and side-effect-in-module-scope rules in the relevant files. The codebase has a custom ESLint rule specifically for `process.env` access patterns that allows controlled side effects at module scope while preventing uncontrolled ones elsewhere.

---

## Phase 2: Parse and Trust (init.ts)

The `init()` function is memoized -- calling it multiple times is safe and returns the same result. This is important because multiple entry points (the REPL, print mode, SDK mode) may each call `init()`, and the memoization guarantees it runs exactly once.

The function resolves command-line arguments via Commander, loads configuration from multiple sources (global settings, project settings, environment variables), and then hits the most important boundary in the pipeline.

### The Trust Boundary

Before the trust boundary, the system operates in a restricted mode. After it, full capabilities are available. The boundary exists because Claude Code reads environment variables -- and environment variables can be poisoned.

```mermaid
sequenceDiagram
    participant S as System
    participant T as Trust Dialog
    participant U as User

    Note over S: Pre-Trust (Safe Only)
    S->>S: TLS/CA certs
    S->>S: Theme preferences
    S->>S: Telemetry opt-out
    S->>S: Config validation

    S->>T: Show trust prompt
    T->>U: "Do you trust this directory?"
    U->>T: Accept

    Note over S: Post-Trust (Full Access)
    S->>S: Read PATH, LD_PRELOAD, NODE_OPTIONS
    S->>S: Execute git commands
    S->>S: Load full env vars
    S->>S: Reset feature flags
```

The trust boundary is not about the user trusting Claude Code. It is about Claude Code trusting the *environment*. A malicious `.bashrc` could set `LD_PRELOAD` to inject code into every subprocess. The trust dialog ensures the user explicitly consents to operating in a directory that may have been configured by someone else.

The system has ten distinct trust-sensitive operations. Before the user accepts the trust dialog, only safe operations run: TLS certificate configuration, theme preferences, telemetry opt-out. After trust, the system reads potentially dangerous environment variables (PATH, LD_PRELOAD, NODE_OPTIONS), executes git commands, and applies the full environment configuration.

### The preAction Hook

Commander's `preAction` hook is the architectural linchpin. Commander parses the command structure (flags, subcommands, positional arguments) *without* executing anything. The `preAction` hook fires after parsing but before the matched command handler runs:

```typescript
program.hook('preAction', async (thisCommand) => {
  await init(thisCommand)
})
```

This separation means fast-path commands (handled in `cli.tsx` before Commander loads) never pay the `init()` cost. Only commands that need the full environment trigger initialization.

---

## Phase 3: Setup (setup.ts)

After `init()` completes, `setup()` registers all the capabilities the system needs:

```mermaid
gantt
    title Phase 3: Parallel Setup
    dateFormat X
    axisFormat %Lms

    section Sequential
    Commands registration   :0, 5
    section Parallel
    Agent definitions      :5, 15
    Hook registration      :5, 12
    Plugin initialization  :5, 20
    MCP server connections :5, 25
```

Commands, agents, hooks, and plugins all register in parallel where possible. The setup phase is where the system transitions from "I know my configuration" to "I have all my capabilities." After setup, every tool is registered, every hook is wired, and the system is ready to handle user input.

Setup also handles the security hook snapshot. The hook configuration is read from disk once, frozen into an immutable snapshot, and used for the rest of the session. Later modifications to the hooks configuration file on disk are ignored. This prevents an attacker from modifying hook rules after the session starts -- the frozen snapshot is the only source of truth for permission decisions.

---

## Phase 4: Launch (replLauncher.ts)

Seven different code paths converge on `replLauncher.ts`: interactive REPL, print mode (`--print`), SDK mode, resume (`--resume`), continue (`--continue`), pipe mode, and headless. The launcher inspects the configuration produced by `init()` and dispatches to the right entry point.

Two examples illustrate the range:

**Interactive REPL** -- the standard case. The launcher mounts the React/Ink component tree, starts the terminal renderer, and enters the event loop. The user sees a prompt and can start typing.

**Print mode** (`--print`) -- a single prompt from argv. The launcher creates a headless query loop with no React tree, runs it to completion, streams the output to stdout, and exits. Same agent loop, different presentation.

The important detail: all seven paths eventually call `query()` -- the same agent loop from Chapter 1. The launch path determines *how* the loop is presented (interactive terminal, single-shot, SDK protocol), not *what* it does. This convergence is what makes the architecture testable and predictable: regardless of how the user invokes Claude Code, the core behavior is identical.

---

## The Startup Timeline

Here is what the full pipeline looks like in time:

```mermaid
gantt
    title Bootstrap Timeline (~240ms)
    dateFormat X
    axisFormat %Lms

    section Phase 0
    Fast-path check          :0, 5

    section Phase 1
    Module evaluation        :5, 143
    MDM subprocess (parallel) :8, 60
    Keychain read (parallel)  :8, 50

    section Phase 2
    Commander parse          :143, 146
    init()                   :146, 160
    Trust boundary           :160, 175

    section Phase 3
    setup() + parallel registration :175, 210

    section Phase 4
    Launch path selection    :210, 215
    First render             :215, 240
```

The critical path runs through module evaluation (the single longest phase at ~138ms), then Commander parse, init, and setup. The parallel I/O operations (MDM, keychain) overlap with module evaluation and are typically resolved before they are needed.

### The Performance Budget

| Phase | Time | What Happens |
|-------|------|-------------|
| Fast-path check | ~5ms | Check argv, exit early if possible |
| Module evaluation | ~138ms | Import tree, fire parallel I/O |
| Commander parse | ~3ms | Parse flags and subcommands |
| init() | ~14ms | Config resolution, trust boundary |
| setup() | ~35ms | Commands, agents, hooks, plugins |
| Launch + first render | ~25ms | Pick path, mount React, first paint |
| **Total** | **~240ms** | Under 300ms budget |

The total is approximately 240ms on a modern machine -- 60ms of headroom under the 300ms budget. Cold starts (first run after reboot, OS cache empty) can push module evaluation to 200ms+, bringing the total closer to the limit.

---

## The Migration System

A brief note on one subsystem that runs during init: schema migrations. Claude Code stores configuration and session data in local files and directories. When the format changes between versions, migrations run automatically at startup.

Each migration is a function with a version number. The system checks the current schema version against the highest migration version, runs pending migrations in order, and updates the version. Migrations are idempotent and fast (operating on small local files, not databases). The entire migration pass typically completes in under 5ms. If a migration fails, it logs the error and continues -- availability beats strict consistency for local configuration.

---

## What Startup Teaches About System Design

The bootstrap pipeline is a study in narrowing scopes. Each phase reduces the space of possibilities:

- Phase 0 narrows from "any CLI invocation" to "needs full bootstrap"
- Phase 1 narrows from "everything must load" to "load in parallel with I/O"
- Phase 2 narrows from "unknown environment" to "trusted, configured environment"
- Phase 3 narrows from "no capabilities" to "fully registered"
- Phase 4 narrows from "seven possible modes" to "one concrete launch path"

By the time the REPL renders, every decision has been made. The query loop receives a fully configured environment with no ambiguity about what mode it is in, which tools are available, or what permissions apply. The 300ms budget is not just a performance target -- it is a forcing function that prevents bootstrap from becoming a lazy initialization system where decisions are deferred and scattered throughout the codebase.

---

## Apply This

**Overlap I/O with initialization.** Fire slow operations (subprocess spawns, credential reads, network checks) at module evaluation time, before they are needed. The JavaScript engine is doing synchronous work anyway -- use that time for parallel I/O. The pattern: `const promise = startSlowThing()` at the top of the file, `await promise` at the point of use.

**Narrow scope as early as possible.** The bootstrap pipeline's five files form a funnel: each phase eliminates work that subsequent phases do not need to do. Fast-path dispatch is the most dramatic example, but the principle applies everywhere. If you can determine at parse time that a code path is unnecessary, skip it.

**Establish trust boundaries explicitly.** If your application reads from an environment it does not control (environment variables, configuration files, shell settings), draw a clear line between "safe to read before the user consents" and "only read after consent." The trust boundary prevents a class of attacks where a malicious environment poisons the application before the user has a chance to evaluate it.

**Memoize your init function.** Make initialization idempotent -- calling it twice produces the same result. This eliminates ordering bugs when multiple entry points may each trigger initialization. The memoization pattern is trivial but eliminates an entire class of double-initialization bugs.

**Capture early input before yielding.** In an event-driven system, user input that arrives during initialization can be lost. Claude Code captures the initial prompt from argv before any async work begins, ensuring that `claude "fix the bug"` does not drop the prompt if initialization takes longer than expected.
