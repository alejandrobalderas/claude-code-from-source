# Chapter 13: The Terminal UI

## Why Build a Custom Renderer?

The terminal is not a browser. There is no DOM, no CSS engine, no compositor, no retained-mode graphics pipeline. There is a stream of bytes going to stdout and a stream of bytes coming from stdin. Everything between those two streams -- layout, styling, diffing, hit-testing, scrolling, selection -- has to be invented from scratch.

Claude Code needs a reactive UI. It has a prompt input, streaming markdown output, permission dialogs, progress spinners, scrollable message lists, search highlighting, and a vim-mode editor. React is the obvious choice for declaring this kind of component tree. But React needs a host environment to render into, and terminals do not provide one.

Ink is the standard answer: a React renderer for terminals, built on Yoga for flexbox layout. Claude Code started with Ink, then forked it beyond recognition. The stock version allocates one JavaScript object per cell per frame -- on a 200x120 terminal, that is 24,000 objects created and garbage-collected every 16ms. It diffs at the string level, comparing entire rows of ANSI-encoded text. It has no concept of blit optimization, no double buffering, no cell-level dirty tracking. For a simple CLI dashboard refreshing once per second, this is fine. For an LLM agent streaming tokens at 60fps while the user scrolls through a conversation with hundreds of messages, it is a non-starter.

What remains in Claude Code is a custom rendering engine that shares Ink's conceptual DNA -- React reconciler, Yoga layout, ANSI output -- but reimplements the critical path: packed typed arrays instead of object-per-cell, pool-based string interning instead of string-per-frame, double-buffered rendering with cell-level diffing, and an optimizer that merges adjacent terminal writes into minimal escape sequences.

The result runs at 60fps on a 200-column terminal while streaming tokens from Claude. To understand how, we need to examine four layers: the custom DOM that React reconciles against, the rendering pipeline that converts that DOM into terminal output, the pool-based memory management that keeps the system alive for hours-long sessions without drowning in garbage collection, and the component architecture that ties it all together.

---

## The Custom DOM

React's reconciler needs something to reconcile against. In the browser, that's the DOM. In Claude Code's terminal, it is a custom in-memory tree with seven element types and one text node type.

The element types map directly to terminal rendering concepts:

- **`ink-root`** -- the document root, one per Ink instance
- **`ink-box`** -- a flexbox container, the terminal equivalent of a `<div>`
- **`ink-text`** -- a text node with a Yoga measure function for word wrapping
- **`ink-virtual-text`** -- nested styled text inside another text node (automatically promoted from `ink-text` when inside a text context)
- **`ink-link`** -- a hyperlink, rendered via OSC 8 escape sequences
- **`ink-progress`** -- a progress indicator
- **`ink-raw-ansi`** -- pre-rendered ANSI content with known dimensions, used for syntax-highlighted code blocks

Each `DOMElement` carries the state that the rendering pipeline needs:

```typescript
// Illustrative — actual interface extends this significantly
interface DOMElement {
  yogaNode: YogaNode;           // Flexbox layout node
  style: Styles;                // CSS-like properties mapped to Yoga
  attributes: Map<string, DOMNodeAttribute>;
  childNodes: (DOMElement | TextNode)[];
  dirty: boolean;               // Needs re-rendering
  _eventHandlers: EventHandlerMap; // Separated from attributes
  scrollTop: number;            // Imperative scroll state
  pendingScrollDelta: number;
  stickyScroll: boolean;
  debugOwnerChain?: string;     // React component stack for debug
}
```

The separation of `_eventHandlers` from `attributes` is deliberate. In React, handler identity changes on every render (unless manually memoized). If handlers were stored as attributes, every render would mark the node dirty and trigger a full repaint. By storing them separately, the reconciler's `commitUpdate` can update handlers without dirtying the node.

The `markDirty()` function is the bridge between DOM mutations and the rendering pipeline. When any node's content changes, `markDirty()` walks up through every ancestor, setting `dirty = true` on each element and calling `yogaNode.markDirty()` on leaf text nodes. This is how a single character change in a deeply nested text node schedules a re-render of the entire path to the root -- but only that path. Sibling subtrees remain clean and can be blitted from the previous frame.

The `ink-raw-ansi` element type deserves special mention. When a code block has already been syntax-highlighted (producing ANSI escape sequences), re-parsing those sequences to extract characters and styles would be wasteful. Instead, the pre-highlighted content is wrapped in an `ink-raw-ansi` node with `rawWidth` and `rawHeight` attributes that tell Yoga the exact dimensions. The rendering pipeline writes the raw ANSI content directly to the output buffer without decomposing it into individual styled characters. This makes syntax-highlighted code blocks essentially zero-cost after the initial highlighting pass -- the most expensive visual element in the UI is also the cheapest to render.

The `ink-text` node's measure function is worth understanding because it runs inside Yoga's layout pass, which is synchronous and blocking. The function receives the available width and must return the text's dimensions. It performs word wrapping (respecting the `wrap` style prop: `wrap`, `truncate`, `truncate-start`, `truncate-middle`), accounts for grapheme cluster boundaries (so it does not split a multi-codepoint emoji across lines), measures CJK double-width characters correctly (each counts as 2 columns), and strips ANSI escape codes from the width calculation (escape sequences have zero visual width). All of this must complete in microseconds per node, because a conversation with 50 visible text nodes means 50 measure function calls per layout pass.

---

## The React Fiber Container

The reconciler bridge uses `react-reconciler` to create a custom host config. This is the same API that React DOM and React Native use. The key difference: Claude Code runs in `ConcurrentRoot` mode.

```typescript
createContainer(rootNode, ConcurrentRoot, ...)
```

ConcurrentRoot enables React's concurrent features -- Suspense for lazy-loaded syntax highlighting, transitions for non-blocking state updates during streaming. The alternative, `LegacyRoot`, would force synchronous rendering and block the event loop during heavy markdown re-parses.

The host config methods map React operations to the custom DOM:

- **`createInstance(type, props)`** creates a `DOMElement` via `createNode()`, applies initial styles and attributes, attaches event handlers, and captures the React component owner chain for debug attribution. The owner chain is stored as `debugOwnerChain` and used by the `CLAUDE_CODE_DEBUG_REPAINTS` mode to attribute full-screen resets to specific components
- **`createTextInstance(text)`** creates a `TextNode` -- but only if we are inside a text context. The reconciler enforces that raw strings must be wrapped in `<Text>`. Attempting to create a text node outside a text context throws, catching a class of bugs at reconciliation time rather than at render time
- **`commitUpdate(node, type, oldProps, newProps)`** diffs old and new props via a shallow comparison, then applies only what changed. Styles, attributes, and event handlers each have their own update path. The diff function returns `undefined` if nothing changed, avoiding unnecessary DOM mutations entirely
- **`removeChild(parent, child)`** removes the node from the tree, recursively frees Yoga nodes (calling `unsetMeasureFunc()` before `free()` to avoid accessing freed WASM memory), and notifies the focus manager
- **`hideInstance(node)` / `unhideInstance(node)`** toggles `isHidden` and switches the Yoga node between `Display.None` and `Display.Flex`. This is React's mechanism for Suspense fallback transitions
- **`resetAfterCommit(container)`** is the critical hook: it calls `rootNode.onComputeLayout()` to run Yoga, then `rootNode.onRender()` to schedule the terminal paint

The reconciler tracks two performance counters per commit cycle: Yoga layout time (`lastYogaMs`) and total commit time (`lastCommitMs`). These flow into the `FrameEvent` that the Ink class reports, enabling performance monitoring in production.

The event system mirrors the browser's capture/bubble model. A `Dispatcher` class implements full event propagation with three phases: capture (root to target), at-target, and bubble (target to root). Event types map to React scheduling priorities -- discrete for keyboard and click (highest priority, processed immediately), continuous for scroll and resize (can be deferred). The dispatcher wraps all event processing in `reconciler.discreteUpdates()` for proper React batching.

When you press a key in the terminal, the resulting `KeyboardEvent` is dispatched through the custom DOM tree, bubbling from the focused element up to the root exactly as a keyboard event would bubble through browser DOM elements. Any handler along the path can call `stopPropagation()` or `preventDefault()`, and the semantics are identical to the browser specification.

---

## The Rendering Pipeline

Every frame traverses seven stages, each timed individually:

```mermaid
flowchart LR
    A[React Commit] --> B[Yoga Layout]
    B --> C[DOM-to-Screen]
    C --> D[Selection/Search<br/>Overlay]
    D --> E[Diff]
    E --> F[Optimize]
    F --> G["Write to stdout<br/>(BSU/ESU atomic)"]

    C -.->|"blit fast path<br/>skips unchanged subtrees"| E

    style A fill:#e3f2fd
    style G fill:#e8f5e9
```

Each stage is timed individually and reported in `FrameEvent.phases`. This per-stage instrumentation is essential for diagnosing performance issues: when a frame takes 30ms, you need to know whether the bottleneck is Yoga re-measuring text (stage 2), the renderer walking a large dirty subtree (stage 3), or stdout backpressure from a slow terminal (stage 7). The answer determines the fix.

**Stage 1: React commit and Yoga layout.** The reconciler processes state updates and calls `resetAfterCommit`. This sets the root node's width to `terminalColumns` and runs `yogaNode.calculateLayout()`. Yoga computes the entire flexbox tree in one pass, following the CSS flexbox specification: it resolves flex-grow, flex-shrink, padding, margin, gap, alignment, and wrapping across all nodes. The results -- `getComputedWidth()`, `getComputedHeight()`, `getComputedLeft()`, `getComputedTop()` -- are cached per node. For `ink-text` nodes, Yoga calls the custom measure function (`measureTextNode`) during layout, which computes text dimensions via word wrapping and grapheme measurement. This is the most expensive per-node operation: it must handle Unicode grapheme clusters, CJK double-width characters, emoji sequences, and ANSI escape codes embedded in text content.

**Stage 2: DOM-to-screen.** The renderer walks the DOM tree depth-first, writing characters and styles into a `Screen` buffer. Each character becomes a packed cell. The output is a complete frame: every cell on the terminal has a defined character, style, and width.

**Stage 3: Overlay.** Text selection and search highlighting modify the screen buffer in-place, flipping style IDs on matching cells. Selection applies inverse video to create the familiar "highlighted text" appearance. Search highlighting applies a more aggressive visual treatment: inverse + yellow foreground + bold + underline for the current match, inverse only for other matches. This contaminates the buffer -- tracked by a `prevFrameContaminated` flag so the next frame knows to skip the blit fast-path. The contamination is a deliberate tradeoff: modifying the buffer in-place avoids allocating a separate overlay buffer (saving 48KB on a 200x120 terminal), at the cost of one full-damage frame after the overlay is cleared.

**Stage 4: Diff.** The new screen is compared cell-by-cell against the front frame's screen. Only changed cells produce output. The comparison is two integer comparisons per cell (the two packed `Int32` words), and the diff walks the damage rectangle rather than the full screen. On a steady-state frame (only a spinner ticking), this might produce patches for 3 cells out of 24,000. Each patch is a `{ type: 'stdout', content: string }` object containing the cursor-move sequence and the ANSI-encoded cell content.

**Stage 5: Optimize.** Adjacent patches on the same row are merged into a single write. Redundant cursor moves are eliminated -- if patch N ends at column 10 and patch N+1 starts at column 11, the cursor is already in the right position and no move sequence is needed. Style transitions are pre-serialized via the `StylePool.transition()` cache, so changing from "bold red" to "dim green" is a single cached string lookup rather than a diff-and-serialize operation. The optimizer typically reduces the byte count by 30-50% compared to naive per-cell output.

**Stage 6: Write.** The optimized patches are serialized to ANSI escape sequences and written to stdout in a single `write()` call, wrapped in synchronous update markers (BSU/ESU) on terminals that support them. BSU (Begin Synchronized Update, `ESC [ ? 2026 h`) tells the terminal to buffer all following output, and ESU (`ESC [ ? 2026 l`) tells it to flush. This eliminates visible tearing on terminals that support the protocol -- the entire frame appears atomically.

Every frame reports its timing breakdown via a `FrameEvent` object:

```typescript
interface FrameEvent {
  durationMs: number;
  phases: {
    renderer: number;    // DOM-to-screen
    diff: number;        // Screen comparison
    optimize: number;    // Patch merging
    write: number;       // stdout write
    yoga: number;        // Layout computation
  };
  yogaVisited: number;   // Nodes traversed
  yogaMeasured: number;  // Nodes that ran measure()
  yogaCacheHits: number; // Nodes with cached layout
  flickers: FlickerEvent[];  // Full-reset attributions
}
```

When `CLAUDE_CODE_DEBUG_REPAINTS` is enabled, full-screen resets are attributed to their source React component via `findOwnerChainAtRow()`. This is the terminal equivalent of React DevTools' "Highlight Updates" -- it shows you which component caused the entire screen to repaint, which is the most expensive thing that can happen in the rendering pipeline.

The blit optimization deserves special attention. When a node is not dirty and its position has not changed since the previous frame (checked via a node cache), the renderer copies cells directly from `prevScreen` to the current screen instead of re-rendering the subtree. This makes steady-state frames extremely cheap -- on a typical frame where only a spinner is ticking, the blit covers 99% of the screen and only the spinner's 3-4 cells are re-rendered from scratch.

The blit is disabled under three conditions:

1. **`prevFrameContaminated` is true** -- the selection overlay or a search highlight modified the front frame's screen buffer in-place, so those cells cannot be trusted as the "correct" previous state
2. **An absolute-positioned node was removed** -- absolute positioning means the node could have painted over non-sibling cells, and those cells need to be re-rendered from the elements that actually own them
3. **Layout shifted** -- any node's cached position differs from its current computed position, meaning the blit would copy cells to the wrong coordinates

The damage rectangle (`screen.damage`) tracks the bounding box of all written cells during rendering. The diff only examines rows within this rectangle, skipping entirely unchanged regions. On a 120-row terminal where a streaming message occupies rows 80-100, the diff checks 20 rows instead of 120 -- a 6x reduction in comparison work.

---

## Double-Buffer Rendering and Frame Scheduling

The Ink class maintains two frame buffers:

```typescript
private frontFrame: Frame;  // Currently displayed on terminal
private backFrame: Frame;   // Being rendered into
```

Each `Frame` contains:

- `screen: Screen` -- the cell buffer (packed `Int32Array`)
- `viewport: Size` -- terminal dimensions at render time
- `cursor: { x, y, visible }` -- where to park the terminal cursor
- `scrollHint` -- DECSTBM (scroll region) optimization hint for alt-screen mode
- `scrollDrainPending` -- whether a ScrollBox has remaining scroll delta to process

After each render, the frames swap: `backFrame = frontFrame; frontFrame = newFrame`. The old front frame becomes the next back frame, providing the `prevScreen` for blit optimization and the baseline for cell-level diffing.

This double-buffer design eliminates allocation. Instead of creating a new `Screen` every frame, the renderer reuses the back frame's buffer. The swap is a pointer assignment. The pattern is borrowed from graphics programming, where double buffering prevents tearing by ensuring the display reads from a complete frame while the renderer writes to the other. In the terminal context, tearing is not the concern (the BSU/ESU protocol handles that); the concern is GC pressure from allocating and discarding `Screen` objects containing 48KB+ of typed arrays every 16ms.

Render scheduling uses lodash `throttle` at 16ms (approximately 60fps), with leading and trailing edges enabled:

```typescript
const deferredRender = () => queueMicrotask(this.onRender);
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true,
});
```

The microtask deferral is not accidental. `resetAfterCommit` runs before React's layout effects phase. If the renderer ran synchronously here, it would miss cursor declarations set in `useLayoutEffect`. The microtask runs after layout effects but within the same event-loop tick -- the terminal sees a single, consistent frame.

For scroll operations, a separate `setTimeout` at 4ms (FRAME_INTERVAL_MS >> 2) provides faster scroll frames without interfering with the throttle. Scroll mutations bypass React entirely: `ScrollBox.scrollBy()` mutates DOM node properties directly, calls `markDirty()`, and schedules a render via microtask. No React state update, no reconciliation overhead, no re-rendering of the entire message list for a single wheel event.

**Resize handling** is synchronous, not debounced. When the terminal resizes, `handleResize` updates dimensions immediately to keep layout consistent. For alt-screen mode, it resets frame buffers and defers `ERASE_SCREEN` into the next atomic BSU/ESU paint block rather than writing it immediately. Writing the erase synchronously would leave the screen blank for the ~80ms the render takes; deferring it into the atomic block means old content stays visible until the new frame is fully ready.

**Alt-screen management** adds another layer. The `AlternateScreen` component enters DEC 1049 alternate screen buffer on mount, constraining height to terminal rows. It uses `useInsertionEffect` -- not `useLayoutEffect` -- to ensure the `ENTER_ALT_SCREEN` escape sequence reaches the terminal before the first render frame. Using `useLayoutEffect` would be too late: the first frame would render to the main screen buffer, producing a visible flash before the switch. `useInsertionEffect` runs before layout effects and before the browser (or terminal) would paint, making the transition seamless.

---

## Pool-Based Memory: Why Interning Matters

A 200-column by 120-row terminal has 24,000 cells. If each cell were a JavaScript object with a `char` string, a `style` string, and a `hyperlink` string, that is 72,000 string allocations per frame -- plus 24,000 object allocations for the cells themselves. At 60fps, that is 5.76 million allocations per second. V8's garbage collector can handle this, but not without pauses that show up as dropped frames. The GC pauses are typically 1-5ms, but they are unpredictable: they might hit during a streaming token update, causing a visible stutter exactly when the user is watching the output.

Claude Code eliminates this entirely with packed typed arrays and three interning pools. The result: zero per-frame object allocations for the cell buffer. The only allocations are in the pools themselves (amortized, since most characters and styles are interned on the first frame and reused thereafter) and in the patch strings produced by the diff (unavoidable, since stdout.write requires string or Buffer arguments).

**The cell layout** uses two `Int32` words per cell, stored in a contiguous `Int32Array`:

```
word0: charId        (32 bits, index into CharPool)
word1: styleId[31:17] | hyperlinkId[16:2] | width[1:0]
```

A parallel `BigInt64Array` view over the same buffer enables bulk operations -- clearing a row is a single `fill()` call on 64-bit words instead of zeroing individual fields.

**CharPool** interns character strings to integer IDs. It has a fast path for ASCII: a 128-entry `Int32Array` maps character codes directly to pool indices, avoiding the `Map` lookup entirely. Multi-byte characters (emoji, CJK ideographs) fall through to a `Map<string, number>`. Index 0 is always space, index 1 is always empty string.

```typescript
export class CharPool {
  private strings: string[] = [' ', '']
  private ascii: Int32Array = initCharAscii()

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        const cached = this.ascii[code]!
        if (cached !== -1) return cached
        const index = this.strings.length
        this.strings.push(char)
        this.ascii[code] = index
        return index
      }
    }
    // Map fallback for multi-byte characters
    ...
  }
}
```

**StylePool** interns arrays of ANSI style codes to integer IDs. The clever part: bit 0 of each ID encodes whether the style has a visible effect on space characters (background color, inverse, underline). Foreground-only styles get even IDs; styles visible on spaces get odd IDs. This lets the renderer skip invisible spaces with a single bitmask check -- `if (!(styleId & 1) && charId === 0) continue` -- without looking up the style definition. The pool also caches pre-serialized ANSI transition strings between any two style IDs, so transitioning from "bold red" to "dim green" is a cached string concatenation, not a diff-and-serialize operation.

**HyperlinkPool** interns OSC 8 hyperlink URIs. Index 0 means no hyperlink.

All three pools are shared across the front and back frames. This is a critical design decision. Because the pools are shared, interned IDs are valid across frames: the blit optimization can copy packed cell words directly from `prevScreen` to the current screen without re-interning. The diff can compare IDs as integers without string lookups. If each frame had its own pools, the blit would need to re-intern every copied cell (looking up the string by old ID, then interning it in the new pool), which would negate most of the blit's performance benefit.

Pools are periodically reset (every 5 minutes) to prevent unbounded growth during long sessions. A migration pass re-interns the front frame's live cells into the fresh pools.

**CellWidth** handles double-wide characters with a 2-bit classification:

| Value | Meaning |
|-------|---------|
| 0 (Narrow) | Standard single-column character |
| 1 (Wide) | CJK/emoji head cell, occupies two columns |
| 2 (SpacerTail) | Second column of a wide character |
| 3 (SpacerHead) | Soft-wrap continuation marker |

This is stored in the low 2 bits of `word1`, making width checks on packed cells free -- no field extraction needed for the common case.

Additional per-cell metadata lives in parallel arrays rather than the packed cells:

- **`noSelect: Uint8Array`** -- per-cell flag excluding content from text selection. Used for UI chrome (borders, indicators) that should not appear in copied text
- **`softWrap: Int32Array`** -- per-row marker indicating word-wrap continuation. When the user selects text across a soft-wrapped line, the selection logic knows not to insert a newline at the wrap point
- **`damage: Rectangle`** -- bounding box of all written cells in the current frame. The diff only examines rows within this rectangle, skipping entirely unchanged regions

These parallel arrays avoid widening the packed cell format (which would increase cache pressure in the diff inner loop) while providing the metadata that selection, copy, and optimization need.

The `Screen` also exposes a `createScreen()` factory that takes dimensions and pool references. Creating a screen zeroes the `Int32Array` via `fill(0n)` on the `BigInt64Array` view -- a single native call that clears the entire buffer in microseconds. This is used during resize (when new frame buffers are needed) and during pool migration (when the old screen's cells are re-interned into fresh pools).

---

## The REPL Component

The REPL (`REPL.tsx`) is approximately 5,000 lines. It is the largest single component in the codebase, and for good reason: it is the orchestrator of the entire interactive experience. Everything flows through it.

The component is organized into roughly nine sections:

1. **Imports** (~100 lines) -- pulls in bootstrap state, commands, history, hooks, components, keybindings, cost tracking, notifications, swarm/team support, voice integration
2. **Feature-flagged imports** -- conditional loading of voice integration, proactive mode, brief tool, and coordinator agent via `feature()` guards with `require()`
3. **State management** -- extensive `useState` calls covering messages, input mode, pending permissions, dialogs, cost thresholds, session state, tool state, and agent state
4. **QueryGuard** -- manages active API call lifecycle, preventing concurrent requests from stepping on each other
5. **Message handling** -- processes incoming messages from the query loop, normalizes ordering, manages streaming state
6. **Tool permission flow** -- coordinates permission requests between tool use blocks and the PermissionRequest dialog
7. **Session management** -- resume, switch, export conversations
8. **Keybinding setup** -- wires the keybinding providers: `KeybindingSetup`, `GlobalKeybindingHandlers`, `CommandKeybindingHandlers`
9. **Render tree** -- composes the final UI from all the above

Its render tree composes the full interface in fullscreen mode:

```mermaid
graph TD
    KS[KeybindingSetup] --> GKH[GlobalKeybindingHandlers]
    KS --> CKH[CommandKeybindingHandlers]
    KS --> CRH[CancelRequestHandler]
    KS --> MSG[Messages / VirtualMessageList]
    KS --> PI[PromptInput<br/>vim mode, autocomplete]
    KS --> PR[PermissionRequest<br/>modal dialog]
    KS --> SL[StatusLine]

    MSG --> LH[LogoHeader]
    MSG --> MR["MessageRow (per message)"]
    MSG --> OF[OffscreenFreeze<br/>wraps non-visible content]

    MR --> M[Message]
    MR --> SM[StreamingMarkdown]
    MR --> TUB[ToolUseBlock]
```

`OffscreenFreeze` is a performance optimization specific to terminal rendering. When a message scrolls above the viewport, its React element is cached and its subtree is frozen. This prevents timer-based updates (spinners, elapsed time counters) in off-screen messages from triggering terminal resets. Without this, a spinning indicator in message 3 would cause a full repaint even though the user is looking at message 47.

The component is compiled by the React Compiler throughout. Instead of manual `useMemo` and `useCallback`, the compiler inserts per-expression memoization using slot arrays:

```typescript
const $ = _c(14);  // 14 memoization slots
let t0;
if ($[0] !== dep1 || $[1] !== dep2) {
  t0 = expensiveComputation(dep1, dep2);
  $[0] = dep1; $[1] = dep2; $[2] = t0;
} else {
  t0 = $[2];
}
```

This pattern appears in every component in the codebase. It provides finer granularity than `useMemo` (which memoizes at the hook level) -- individual expressions within a render function get their own dependency tracking and caching. For a 5,000-line component like the REPL, this eliminates hundreds of potential unnecessary recomputations per render.

---

## Selection and Search Highlighting

Text selection and search highlighting operate as screen-buffer overlays, applied after the main render but before the diff.

**Text selection** is alt-screen only. The Ink instance holds a `SelectionState` tracking anchor and focus points, drag mode (character/word/line), and captured rows that have scrolled off-screen. When the user clicks and drags, the selection handler updates these coordinates. During `onRender`, `applySelectionOverlay` walks the affected rows and modifies cell style IDs in-place using `StylePool.withSelectionBg()`, which returns a new style ID with inverse video added. This direct mutation of the screen buffer is why the `prevFrameContaminated` flag exists -- the front frame's buffer has been modified by the overlay, so the next frame cannot trust it for blit optimization and must do a full-damage diff.

Mouse tracking uses SGR 1003 mode, which reports clicks, drags, and motion with column/row coordinates. The `App` component implements multi-click detection: double-click selects a word, triple-click selects a line. The detection uses a 500ms timeout and 1-cell position tolerance (the mouse can move one cell between clicks without resetting the multi-click counter). Hyperlink clicks are intentionally deferred by this timeout -- double-clicking a link selects the word instead of opening the browser, matching the behavior users expect from text editors.

A lost-release recovery mechanism handles the case where the user starts a drag inside the terminal, moves the mouse outside the window, and releases. The terminal reports the press and the drag, but not the release (which happened outside its window). Without recovery, the selection would be stuck in drag mode permanently. The recovery works by detecting mouse motion events with no buttons pressed -- if we are in a drag state and receive a no-button motion event, we infer that the button was released outside the window and finalize the selection.

**Search highlighting** has two mechanisms running in parallel. The scan-based path (`applySearchHighlight`) walks visible cells looking for the query string and applies SGR inverse styling. The position-based path uses pre-computed `MatchPosition[]` from `scanElementSubtree()`, stored message-relative, and applies them at known offsets with a "current match" yellow highlight using stacked ANSI codes (inverse + yellow foreground + bold + underline). The yellow foreground combined with inverse becomes a yellow background -- the terminal swaps fg/bg when inverse is active. The underline is the fallback visibility marker for themes where the yellow clashes with existing background colors.

**Cursor declaration** solves a subtle problem. Terminal emulators render IME (Input Method Editor) preedit text at the physical cursor position. CJK users composing characters need the cursor to be at the text input's caret, not at the bottom of the screen where the terminal would naturally park it. The `useDeclaredCursor` hook lets a component declare where the cursor should be after each frame. The Ink class reads the declared node's position from `nodeCache`, translates it to screen coordinates, and emits cursor-move sequences after the diff. Screen readers and magnifiers also track the physical cursor, so this mechanism benefits accessibility as well as CJK input.

In main-screen mode, the declared cursor position is tracked separately from `frame.cursor` (which must stay at the content bottom for the log-update's relative-move invariants). In alt-screen mode, the problem is simpler: every frame begins with `CSI H` (cursor home), so the declared cursor is just an absolute position emitted at the end of the frame.

---

## Streaming Markdown

Rendering LLM output is the most demanding task the terminal UI faces. Tokens arrive one at a time, 10-50 per second, and each one changes the content of a message that might contain code blocks, lists, bold text, and inline code. The naive approach -- re-parse the entire message on every token -- would be catastrophic at scale.

Claude Code uses three optimizations:

**Token caching.** A module-level LRU cache (500 entries) stores `marked.lexer()` results keyed by content hash. The cache survives React unmount/remount cycles during virtual scrolling. When a user scrolls back to a previously visible message, the markdown tokens are served from cache instead of re-parsed.

**Fast-path detection.** `hasMarkdownSyntax()` checks the first 500 characters for markdown markers via a single regex. If no syntax is found, it constructs a single-paragraph token directly, bypassing the full GFM parser. This saves approximately 3ms per render on plain-text messages -- which matters when you are rendering 60 frames per second.

**Lazy syntax highlighting.** Code block highlighting is loaded via React `Suspense`. The `MarkdownBody` component renders immediately with `highlight={null}` as a fallback, then resolves asynchronously with the cli-highlight instance. The user sees the code immediately (unstyled), then it pops into color a frame or two later.

The streaming case adds a wrinkle. When tokens arrive from the model, the markdown content grows incrementally. Re-parsing the entire content on every token would be O(n^2) over the course of a message. The fast-path detection helps -- most streaming content is plain text paragraphs, which bypass the parser entirely -- but for messages with code blocks and lists, the LRU cache provides the real optimization. The cache key is the content hash, so when 10 tokens arrive and only the last paragraph changes, the cached parse result for the unchanged prefix is reused. The markdown renderer only re-parses the tail that changed.

The `StreamingMarkdown` component is distinct from the static `Markdown` component. It handles the case where the content is still being generated: incomplete code fences (a ` ``` ` without a closing fence), partial bold markers, and truncated list items. The streaming variant is more forgiving in its parsing -- it does not error on unclosed syntax because the closing syntax has not arrived yet. When the message finishes streaming, the component transitions to the static `Markdown` renderer, which applies full GFM parsing with strict syntax checking.

Syntax highlighting for code blocks is the most expensive per-element operation in the rendering pipeline. A 100-line code block can take 50-100ms to highlight with cli-highlight. Loading the highlighting library itself takes 200-300ms (it bundles grammar definitions for dozens of languages). Both costs are hidden behind React `Suspense`: the code block renders immediately as plain text, the highlighting library loads asynchronously, and when it resolves, the code block re-renders with colors. The user sees code instantly and colors a moment later -- a much better experience than a 300ms blank frame while the library loads.

---

## Apply This: Rendering Streaming Output Efficiently

The terminal rendering pipeline is a case study in eliminating work. Three principles drive the design:

**Intern everything.** If you have a value that appears in thousands of cells -- a style, a character, a URL -- store it once and reference it by integer ID. Integer comparison is one CPU instruction. String comparison is a loop. When your inner loop runs 24,000 times per frame at 60fps, the difference between `===` on integers and `===` on strings is the difference between smooth scrolling and visible lag.

**Diff at the right level.** Cell-level diffing sounds expensive -- 24,000 comparisons per frame. But it is two integer comparisons per cell (the packed words), and on a steady-state frame, the diff bails out of most rows after checking the first cell. The alternative -- re-rendering the entire screen and writing it to stdout -- would produce 100KB+ of ANSI escape sequences per frame. The diff typically produces under 1KB.

**Separate the hot path from React.** Scroll events arrive at mouse-input frequency (potentially hundreds per second). Routing each one through React's reconciler -- state update, reconciliation, commit, layout, render -- adds 5-10ms of latency per event. By mutating DOM nodes directly and scheduling renders via microtask, the scroll path stays under 1ms. React is involved only in the final paint, where it would run anyway.

These principles apply to any streaming output system, not just terminals. If you are building a web application that renders real-time data -- a log viewer, a chat client, a monitoring dashboard -- the same tradeoffs apply. Intern repeated values. Diff against the previous frame. Keep the hot path out of your reactive framework.

A fourth principle, specific to long-running sessions: **clean up periodically.** Claude Code's pools grow monotonically as new characters and styles are interned. Over a multi-hour session, the pools could accumulate thousands of entries that are no longer referenced by any live cell. The 5-minute reset cycle bounds this growth: every 5 minutes, fresh pools are created, the front frame's cells are migrated (re-interned into the new pools), and the old pools become garbage. This is a generational collection strategy, applied at the application level because the JavaScript GC has no visibility into the semantic liveness of pool entries.

The decision to use `Int32Array` over plain objects has a subtler benefit beyond GC pressure: memory locality. When the diff compares 24,000 cells, it walks a contiguous typed array. Modern CPUs prefetch sequential memory accesses, so the entire screen comparison runs within the L1/L2 cache. An object-per-cell layout would scatter cells across the heap, turning every comparison into a cache miss. The performance difference is measurable: on a 200x120 screen, the typed-array diff completes in under 0.5ms, while an equivalent object-based diff takes 3-5ms -- enough to blow the 16ms frame budget when combined with the other pipeline stages.

A fifth principle applies to any system that renders into a fixed-size grid: **track damage bounds.** The `damage` rectangle on each screen records the bounding box of cells that were written during rendering. The diff consults this rectangle and skips rows outside it entirely. When a streaming message occupies the bottom 20 rows of a 120-row terminal, the diff examines 20 rows, not 120. Combined with the blit optimization (which populates the damage rectangle only for re-rendered regions, not blitted ones), this means the common case -- one message streaming while the rest of the conversation is static -- touches a fraction of the screen buffer.

The broader lesson: performance in a rendering system is not about making any single operation fast. It is about eliminating operations entirely. The blit eliminates re-rendering. The damage rectangle eliminates diffing. The pool sharing eliminates re-interning. The packed cells eliminate allocation. Each optimization removes an entire category of work, and they stack multiplicatively.

To put numbers on it: a worst-case frame (everything dirty, no blit, full-screen damage) on a 200x120 terminal takes approximately 12ms. A best-case frame (one dirty node, blit everything else, 3-row damage rectangle) takes under 1ms. The system spends most of its time in the best case. The streaming token arrival triggers one dirty text node, which dirties its ancestors up to the message container, which is typically 10-30 rows of the screen. The blit handles the other 90-110 rows. The damage rectangle constrains the diff to the dirty region. The pool lookups are integer operations. The steady-state cost of streaming one token is dominated by Yoga layout (which re-measures the dirty text node and its ancestors) and the markdown re-parse -- not by the rendering pipeline itself.


---


