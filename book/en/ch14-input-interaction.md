# Chapter 14: Input and Interaction

## Raw Bytes, Meaningful Actions

When you press Ctrl+X followed by Ctrl+K in Claude Code, the terminal sends two byte sequences separated by perhaps 200 milliseconds. The first is `0x18` (ASCII CAN). The second is `0x0B` (ASCII VT). Neither of these bytes carries any inherent meaning beyond "control character." The input system must recognize that these two bytes, arriving in sequence within a timeout window, constitute the chord `ctrl+x ctrl+k`, which maps to the action `chat:killAgents`, which terminates all running sub-agents.

Between the raw bytes and the killed agents, six systems activate: a tokenizer splits escape sequences, a parser classifies them across five terminal protocols, a keybinding resolver matches the sequence against context-specific bindings, a chord state machine manages the multi-key sequence, a handler executes the action, and React batches the resulting state updates into a single render.

The difficulty is not in any one of these systems. It is in the combinatorial explosion of terminal diversity. iTerm2 sends Kitty keyboard protocol sequences. macOS Terminal sends legacy VT220 sequences. Ghostty over SSH sends xterm modifyOtherKeys. tmux may eat, transform, or passthrough any of these depending on its configuration. Windows Terminal has its own quirks with VT mode. The input system must produce correct `ParsedKey` objects from all of them, because a user should not have to know which keyboard protocol their terminal uses.

This chapter traces the path from raw bytes to meaningful actions across that landscape.

The design philosophy is progressive enhancement with graceful degradation. On a modern terminal with Kitty keyboard protocol support, Claude Code gets full modifier detection (Ctrl+Shift+A is distinct from Ctrl+A), super key reporting (Cmd shortcuts), and unambiguous key identification. On a legacy terminal over SSH, it falls back to the best available protocol, losing some modifier distinctions but keeping core functionality intact. The user never sees an error message about their terminal being unsupported. They might not be able to use `ctrl+shift+f` for global search, but `ctrl+r` for history search works everywhere.

---

## The Key Parsing Pipeline

Input arrives as chunks of bytes on stdin. The pipeline processes them in stages:

```mermaid
flowchart TD
    STDIN["stdin (raw bytes)"] --> READ["App.handleReadable()"]
    READ --> PROC["processInput(chunk)"]
    PROC --> PARSE["parseMultipleKeypresses(state, input)"]
    PARSE --> TOK["termio tokenizer<br/>splits escape sequences, 50ms timeout"]

    TOK --> CLS{Classify token}
    CLS -->|Terminal response| TQ[TerminalQuerier<br/>DA1, XTVERSION, cursor pos]
    CLS -->|Mouse event| SEL[Selection/click handlers]
    CLS -->|Keypress| KBD[handleInput + DOM dispatch]

    KBD --> BATCH["reconciler.discreteUpdates()<br/>batch all keys from single read()"]
    SEL --> BATCH

    style STDIN fill:#fff3e0
    style BATCH fill:#e8f5e9
```

The tokenizer is the foundation. Terminal input is a stream of bytes that mixes printable characters, control codes, and multi-byte escape sequences with no explicit framing. A single `read()` from stdin might return `\x1b[1;5A` (Ctrl+Up arrow), or it might return `\x1b` in one read and `[1;5A` in the next, depending on how fast bytes arrive from the PTY. The tokenizer maintains a state machine that buffers partial escape sequences and emits complete tokens.

The incomplete-sequence problem is fundamental. When the tokenizer sees a lone `\x1b`, it cannot know whether this is the Escape key or the start of a CSI sequence. It buffers the byte and starts a 50ms timer. If no continuation arrives, the buffer is flushed and the `\x1b` becomes an Escape keypress. But before flushing, the tokenizer checks `stdin.readableLength` -- if bytes are waiting in the kernel buffer, the timer re-arms rather than flushing. This handles the case where the event loop was blocked past 50ms and the continuation bytes are already buffered but not yet read.

For paste operations, the timeout extends to 500ms. Pasted text can be large and arrive in multiple chunks.

All parsed keys from a single `read()` are processed in one `reconciler.discreteUpdates()` call. This batches React state updates so that pasting 100 characters produces one re-render, not 100. The batching is essential: without it, each character in a paste would trigger a full reconciliation cycle -- state update, reconciliation, commit, Yoga layout, render, diff, write. At 5ms per cycle, a 100-character paste would take 500ms to process. With batching, the same paste takes one 5ms cycle.

### stdin Management

The `App` component manages raw mode via reference counting. When any component needs raw input (the prompt, a dialog, vim mode), it calls `setRawMode(true)`, incrementing a counter. When it no longer needs raw input, it calls `setRawMode(false)`, decrementing. Raw mode is only disabled when the counter reaches zero. This prevents a common bug in terminal applications: component A enables raw mode, component B enables raw mode, component A disables raw mode, and suddenly component B's input breaks because raw mode was globally disabled.

When raw mode is first enabled, the App:

1. Stops early input capture (the bootstrap-phase mechanism that collects keystrokes before React mounts)
2. Puts stdin into raw mode (no line buffering, no echo, no signal processing)
3. Attaches a `readable` listener for async input processing
4. Enables bracketed paste (so pasted text is identifiable)
5. Enables focus reporting (so the app knows when the terminal window gains/loses focus)
6. Enables extended key reporting (Kitty keyboard protocol + xterm modifyOtherKeys)

On disable, all of these are reversed in the opposite order. The careful sequencing prevents escape sequence leaks -- disabling extended key reporting before disabling raw mode ensures that the terminal does not continue sending Kitty-encoded sequences after the app has stopped parsing them.

The `onExit` signal handler (via the `signal-exit` package) ensures cleanup happens even on unexpected termination. If the process receives SIGTERM or SIGINT, the handler disables raw mode, restores the terminal state, exits alternate screen if active, and re-shows the cursor before the process exits. Without this cleanup, a crashed Claude Code session would leave the terminal in raw mode with no cursor and no echo -- the user would need to blindly type `reset` to recover their terminal.

---

## Multi-Protocol Support

Terminals do not agree on how to encode keyboard input. A modern terminal emulator like Kitty sends structured sequences with full modifier information. A legacy terminal over SSH sends ambiguous byte sequences that require context to interpret. Claude Code's parser handles five distinct protocols simultaneously, because the user's terminal might be any of them.

**CSI u (Kitty keyboard protocol)** is the modern standard. Format: `ESC [ codepoint [; modifier] u`. Example: `ESC[13;2u` is Shift+Enter, `ESC[27u` is Escape with no modifiers. The codepoint identifies the key unambiguously -- there is no ambiguity between Escape-the-key and Escape-as-sequence-prefix. The modifier word encodes shift, alt, ctrl, and super (Cmd) as individual bits. Claude Code enables this protocol on terminals that support it via the `ENABLE_KITTY_KEYBOARD` escape sequence at startup, and disables it on exit via `DISABLE_KITTY_KEYBOARD`. The protocol is detected through a query/response handshake: the application sends `CSI ? u` and the terminal responds with `CSI ? flags u`, where `flags` indicates the supported protocol level.

**xterm modifyOtherKeys** is the fallback for terminals like Ghostty over SSH, where the Kitty protocol is not negotiated. Format: `ESC [ 27 ; modifier ; keycode ~`. Note that the parameter order is reversed from CSI u -- modifier comes before keycode, then keycode. This is a common source of parser bugs. The protocol is enabled via `CSI > 4 ; 2 m` and emitted by Ghostty, tmux, and xterm when the terminal's TERM identification is not detected (common over SSH where `TERM_PROGRAM` is not forwarded).

**Legacy terminal sequences** cover everything else: function keys via `ESC O` and `ESC [` sequences, arrow keys, numpad, Home/End/Insert/Delete, and the full zoo of VT100/VT220/xterm variations accumulated over 40 years of terminal evolution. The parser uses two regular expressions to match these: `FN_KEY_RE` for the `ESC O/N/[/[[` prefix pattern (matching function keys, arrow keys, and their modified variants), and `META_KEY_CODE_RE` for meta-key codes (`ESC` followed by a single alphanumeric, the traditional Alt+key encoding).

The challenge with legacy sequences is ambiguity. `ESC [ 1 ; 2 R` could be Shift+F3 or a cursor position report, depending on context. The parser resolves this with a private-marker check: cursor position reports use `CSI ? row ; col R` (with the `?` private marker), while modified function keys use `CSI params R` (without it). This disambiguation is why Claude Code requests DECXCPR (extended cursor position reports) rather than standard CPR -- the extended form is unambiguous.

Terminal identification adds another layer of complexity. On startup, Claude Code sends an `XTVERSION` query (`CSI > 0 q`) to discover the terminal's name and version. The response (`DCS > | name ST`) survives SSH connections -- unlike `TERM_PROGRAM`, which is an environment variable that does not propagate through SSH. Knowing the terminal identity allows the parser to handle terminal-specific quirks. For example, xterm.js (used by VS Code's integrated terminal) has different escape sequence behavior from native xterm, and the identification string (`xterm.js(X.Y.Z)`) allows the parser to account for these differences.

**SGR mouse events** use the format `ESC [ < button ; col ; row M/m`, where `M` is press and `m` is release. Button codes encode the action: 0/1/2 for left/middle/right click, 64/65 for wheel up/down (0x40 OR'd with a wheel bit), 32+ for drag (0x20 OR'd with a motion bit). Wheel events are converted to `ParsedKey` objects so they flow through the keybinding system; click and drag events become `ParsedMouse` objects routed to the selection handler.

**Bracketed paste** wraps pasted content between `ESC [200~` and `ESC [201~` markers. Everything between the markers becomes a single `ParsedKey` with `isPasted: true`, regardless of what escape sequences the pasted text might contain. This prevents pasted code from being interpreted as commands -- a critical safety feature when a user pastes a code snippet containing `\x03` (which is Ctrl+C as a raw byte).

The output types from the parser form a clean discriminated union:

```typescript
type ParsedKey = {
  kind: 'key';
  name: string;        // 'return', 'escape', 'a', 'f1', etc.
  ctrl: boolean; meta: boolean; shift: boolean;
  option: boolean; super: boolean;
  sequence: string;    // Raw escape sequence for debugging
  isPasted: boolean;   // Inside bracketed paste
}

type ParsedMouse = {
  kind: 'mouse';
  button: number;      // SGR button code
  action: 'press' | 'release';
  col: number; row: number;  // 1-indexed terminal coordinates
}

type ParsedResponse = {
  kind: 'response';
  response: TerminalResponse;  // Routed to TerminalQuerier
}
```

The `kind` discriminant ensures that downstream code handles each input type explicitly. A key cannot be accidentally processed as a mouse event; a terminal response cannot be accidentally interpreted as a keypress. The `ParsedKey` type also carries the raw `sequence` string for debugging -- when a user reports "pressing Ctrl+Shift+A does nothing," the debug log can show exactly what byte sequence the terminal sent, making it possible to diagnose whether the issue is in the terminal's encoding, the parser's recognition, or the keybinding's configuration.

The `isPasted` flag on `ParsedKey` is critical for security. When bracketed paste is enabled, the terminal wraps pasted content in marker sequences. The parser sets `isPasted: true` on the resulting key event, and the keybinding resolver skips keybinding matching for pasted keys. Without this, pasting text containing `\x03` (Ctrl+C as a raw byte) or escape sequences would trigger application commands. With it, pasted content is treated as literal text input regardless of its byte content.

The parser also recognizes terminal responses -- sequences sent by the terminal itself in answer to queries. These include device attributes (DA1, DA2), cursor position reports, Kitty keyboard flag responses, XTVERSION (terminal identification), and DECRPM (mode status). These are routed to a `TerminalQuerier` rather than the input handler:

```typescript
type TerminalResponse =
  | { type: 'decrpm'; mode: number; status: number }
  | { type: 'da1'; params: number[] }
  | { type: 'da2'; params: number[] }
  | { type: 'kittyKeyboard'; flags: number }
  | { type: 'cursorPosition'; row: number; col: number }
  | { type: 'osc'; code: number; data: string }
  | { type: 'xtversion'; version: string }
```

**Modifier decoding** follows the XTerm convention: the modifier word is `1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (super ? 8 : 0)`. The `meta` field in `ParsedKey` maps to Alt/Option (bit 2). The `super` field is distinct (bit 8, Cmd on macOS). This distinction matters because Cmd shortcuts are reserved by the OS and cannot be captured by terminal applications -- unless the terminal uses the Kitty protocol, which reports super-modified keys that other protocols silently swallow.

A stdin-gap detector triggers terminal mode re-assertion when no input arrives for 5 seconds after a gap. This handles tmux reattach and laptop wake scenarios, where the terminal's keyboard mode may have been reset by the multiplexer or the OS. When re-assertion fires, it re-sends `ENABLE_KITTY_KEYBOARD`, `ENABLE_MODIFY_OTHER_KEYS`, bracketed paste, and focus reporting sequences. Without this, detaching from a tmux session and reattaching would silently downgrade the keyboard protocol to legacy mode, breaking modifier detection for the rest of the session.

### The Terminal I/O Layer

Beneath the parser sits a structured terminal I/O subsystem in `ink/termio/`:

- **csi.ts** -- CSI (Control Sequence Introducer) sequences: cursor movement, erase, scroll regions, bracketed paste enable/disable, focus event enable/disable, Kitty keyboard protocol enable/disable
- **dec.ts** -- DEC private mode sequences: alternate screen buffer (1049), mouse tracking modes (1000/1002/1003), cursor visibility, bracketed paste (2004), focus events (1004)
- **osc.ts** -- Operating System Commands: clipboard access (OSC 52), tab status, iTerm2 progress indicators, tmux/screen multiplexer wrapping (DCS passthrough for sequences that need to traverse a multiplexer boundary)
- **sgr.ts** -- Select Graphic Rendition: the ANSI style code system (colors, bold, italic, underline, inverse)
- **tokenize.ts** -- The stateful tokenizer for escape sequence boundary detection

The multiplexer wrapping deserves a note. When Claude Code runs inside tmux, certain escape sequences (like Kitty keyboard protocol negotiation) must pass through to the outer terminal. tmux uses DCS passthrough (`ESC P ... ST`) to forward sequences it does not understand. The `wrapForMultiplexer` function in `osc.ts` detects the multiplexer environment and wraps sequences appropriately. Without this, Kitty keyboard mode would silently fail inside tmux, and the user would never know why their Ctrl+Shift bindings stopped working.

### The Event System

The `ink/events/` directory implements a browser-compatible event system with seven event types: `KeyboardEvent`, `ClickEvent`, `FocusEvent`, `InputEvent`, `TerminalFocusEvent`, and base `TerminalEvent`. Each carries `target`, `currentTarget`, `eventPhase`, and supports `stopPropagation()`, `stopImmediatePropagation()`, and `preventDefault()`.

The `InputEvent` wrapping `ParsedKey` exists for backward compatibility with the legacy `EventEmitter` path, which older components may still use. New components use the DOM-style keyboard event dispatch with capture/bubble phases. Both paths fire from the same parsed key, so they are always consistent -- a key that arrives on stdin produces exactly one `ParsedKey`, which spawns both an `InputEvent` (for legacy listeners) and a `KeyboardEvent` (for DOM-style dispatch). This dual-path design allows incremental migration from the EventEmitter pattern to the DOM event pattern without breaking existing components.

---

## The Keybinding System

The keybinding system separates three concerns that are often tangled together: what key triggers what action (bindings), what happens when an action fires (handlers), and which bindings are active right now (contexts).

### Bindings: Declarative Configuration

Default bindings are defined in `defaultBindings.ts` as an array of `KeybindingBlock` objects, each scoped to a context:

```typescript
export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+r': 'history:search',
    },
  },
  {
    context: 'Chat',
    bindings: {
      'escape': 'chat:cancel',
      'ctrl+x ctrl+k': 'chat:killAgents',
      'enter': 'chat:submit',
      'up': 'history:previous',
      'ctrl+x ctrl+e': 'chat:externalEditor',
    },
  },
  // ... 14 more contexts
]
```

Platform-specific bindings are handled at definition time. Image paste is `ctrl+v` on macOS/Linux but `alt+v` on Windows (where `ctrl+v` is system paste). Mode cycling is `shift+tab` on terminals with VT mode support but `meta+m` on Windows Terminal without it. Feature-flagged bindings (quick search, voice mode, terminal panel) are conditionally included.

Users can override any binding via `~/.claude/keybindings.json`. The parser accepts modifier aliases (`ctrl`/`control`, `alt`/`opt`/`option`, `cmd`/`command`/`super`/`win`), key aliases (`esc` -> `escape`, `return` -> `enter`), chord notation (space-separated steps like `ctrl+k ctrl+s`), and null actions to unbind default keys. A null action is not the same as not defining a binding -- it explicitly blocks the default binding from firing, which is important for users who want to reclaim a key for their terminal's use.

### Contexts: 16 Scopes of Activity

Each context represents a mode of interaction where a specific set of bindings applies:

| Context | When Active |
|---------|------------|
| Global | Always |
| Chat | Prompt input is focused |
| Autocomplete | Completion menu is visible |
| Confirmation | Permission dialog is showing |
| Scroll | Alt-screen with scrollable content |
| Transcript | Read-only transcript viewer |
| HistorySearch | Reverse history search (ctrl+r) |
| Task | A background task is running |
| Help | Help overlay is displayed |
| MessageSelector | Rewind dialog |
| MessageActions | Message cursor navigation |
| DiffDialog | Diff viewer |
| Select | Generic selection list |
| Settings | Config panel |
| Tabs | Tab navigation |
| Footer | Footer indicators |

When a key arrives, the resolver builds a context list from the currently active contexts (determined by React component state), deduplicates it preserving priority order, and searches for a matching binding. The last matching binding wins -- this is how user overrides take precedence over defaults. The context list is rebuilt on every keystroke (it is cheap: array concatenation and deduplication of at most 16 strings), so context changes take effect immediately without any subscription or listener mechanism.

The context design handles a tricky interaction pattern: nested modals. When a permission dialog appears during a running task, both `Confirmation` and `Task` contexts might be active. The `Confirmation` context takes priority (it is registered later in the component tree), so `y` triggers "approve" rather than any task-level binding. When the dialog closes, the `Confirmation` context deactivates and `Task` bindings resume. This stacking behavior emerges naturally from the context list's priority ordering -- no special modal-handling code is needed.

### Reserved Shortcuts

Not everything can be rebound. The system enforces three tiers of reservation:

**Non-rebindable** (hardcoded behavior): `ctrl+c` (interrupt/exit), `ctrl+d` (exit), `ctrl+m` (identical to Enter in all terminals -- rebinding it would break Enter).

**Terminal-reserved** (warnings): `ctrl+z` (SIGTSTP), `ctrl+\` (SIGQUIT). These can technically be bound, but the terminal will intercept them before the application sees them in most configurations.

**macOS-reserved** (errors): `cmd+c`, `cmd+v`, `cmd+x`, `cmd+q`, `cmd+w`, `cmd+tab`, `cmd+space`. The OS intercepts these before they reach the terminal. Binding them would create a shortcut that never fires.

### The Resolution Flow

When a key arrives, the resolution path is:

1. Build the context list: the component's registered active contexts plus Global, deduplicated with priority preserved
2. Call `resolveKeyWithChordState(input, key, contexts)` against the merged binding table
3. On `match`: clear any pending chord, call the handler, `stopImmediatePropagation()` on the event
4. On `chord_started`: save the pending keystrokes, stop propagation, start the chord timeout
5. On `chord_cancelled`: clear the pending chord, let the event fall through
6. On `unbound`: clear the chord -- this is an explicit unbinding (user set the action to `null`), so propagation is stopped but no handler runs
7. On `none`: fall through to other handlers

The "last wins" resolution strategy means that if both the default bindings and user bindings define `ctrl+k` in the `Chat` context, the user's binding takes precedence. This is evaluated at match time by iterating bindings in definition order and keeping the last match, rather than building an override map at load time. The advantage: context-specific overrides compose naturally. A user can override `enter` in `Chat` without affecting `enter` in `Confirmation`.

---

## Chord Support

The `ctrl+x ctrl+k` binding is a chord: two keystrokes that together form a single action. The resolver manages this with a state machine.

When a key arrives:

1. The resolver appends it to any pending chord prefix
2. It checks whether any binding's chord starts with this prefix. If so, it returns `chord_started` and saves the pending keystrokes
3. If the full chord matches a binding exactly, it returns `match` and clears the pending state
4. If the chord prefix matches nothing, it returns `chord_cancelled`

A `ChordInterceptor` component intercepts all input during the chord wait state. It has a 1000ms timeout -- if the second keystroke does not arrive within a second, the chord is cancelled and the first keystroke is discarded. The `KeybindingContext` provides a `pendingChordRef` for synchronous access to the pending state, avoiding React state update delays that could cause the second keystroke to be processed before the first one's state update completes.

The chord design avoids shadowing readline editing keys. Without chords, the keybinding for "kill agents" might be `ctrl+k` -- but that is readline's "kill to end of line," which users expect in a terminal text input. By using `ctrl+x` as a prefix (matching readline's own chord prefix convention), the system gets a namespace of bindings that do not conflict with single-key editing shortcuts.

The implementation handles an edge case that most chord systems miss: what happens when the user presses `ctrl+x` but then types a character that is not part of any chord? Without careful handling, that character would be swallowed -- the chord interceptor consumed the input, the chord was cancelled, and the character is gone. Claude Code's `ChordInterceptor` returns `chord_cancelled` in this case, which causes the pending input to be discarded but allows the non-matching character to fall through to normal input processing. The character is not lost; only the chord prefix is discarded. This matches the behavior users expect from Emacs-style chord prefixes.

---

## Vim Mode

### The State Machine

The vim implementation is a pure state machine with exhaustive type checking. The types are the documentation:

```typescript
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
```

This is a discriminated union with 12 variants. TypeScript's exhaustive checking ensures that every `switch` statement on `CommandState.type` handles all 12 cases. Adding a new state to the union causes every incomplete switch to produce a compile error. The state machine cannot have dead states or missing transitions -- the type system forbids it.

Notice how each state carries exactly the data needed for the next transition. The `operator` state knows which operator (`op`) and the preceding count. The `operatorCount` state adds the digit accumulator (`digits`). The `operatorTextObj` state adds the scope (`inner` or `around`). No state carries data it does not need. This is not just good taste -- it prevents an entire class of bugs where a handler reads stale data from a previous command. If you are in the `find` state, you have a `FindType` and a `count`. You do not have an operator, because no operator is pending. The type makes the impossible state unrepresentable.

The state diagram tells the story:

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> count: 1-9
    idle --> operator: d/c/y
    idle --> find: f/F/t/T
    idle --> g_prefix: g
    idle --> replace: r
    idle --> indent: > / <

    count --> operator: d/c/y
    count --> find: f/F/t/T
    count --> idle: motion executes

    operator --> idle: motion executes (dw, d$)
    operator --> idle: self-repeat (dd)
    operator --> operatorCount: 2-9
    operator --> operatorTextObj: i/a
    operator --> operatorFind: f/F/t/T

    operatorCount --> idle: motion executes (d2w)
    operatorTextObj --> idle: object executes (di")
    operatorFind --> idle: char executes (dfa)

    find --> idle: char found/not found
    g_prefix --> idle: gg, gj, gk
    replace --> idle: replacement char
    indent --> idle: repeat (>>, <<)
```

From `idle`, pressing `d` enters the `operator` state. From `operator`, pressing `w` executes `delete` with the `w` motion. Pressing `d` again (`dd`) triggers a line deletion. Pressing `2` enters `operatorCount`, so `d2w` becomes "delete the next 2 words." Pressing `i` enters `operatorTextObj`, so `di"` becomes "delete inside quotes." Every intermediate state carries exactly the context needed for the next transition -- no more, no less.

### Transitions as Pure Functions

The `transition()` function dispatches on the current state type to one of 10 handler functions. Each returns a `TransitionResult`:

```typescript
type TransitionResult = {
  next?: CommandState;    // New state (omitted = stay in current)
  execute?: () => void;   // Side effect (omitted = no action yet)
}
```

Side effects are returned, not executed. The transition function is pure -- given a state and a key, it returns the next state and optionally a closure that performs the action. The caller decides when to run the effect. This makes the state machine trivially testable: feed it states and keys, assert on the returned states, ignore the closures. It also means the transition function has no dependencies on the editor state, the cursor position, or the buffer content. Those details are captured by the closure at creation time, not consumed by the state machine at transition time.

The `fromIdle` handler is the entry point and covers the full vim vocabulary:

- **Count prefix**: `1-9` enters the `count` state, accumulating digits. `0` is special -- it is the "start of line" motion, not a count digit, unless digits have already been accumulated
- **Operators**: `d`, `c`, `y` enter the `operator` state, waiting for a motion or text object to define the range
- **Find**: `f`, `F`, `t`, `T` enter the `find` state, waiting for a character to search for
- **G-prefix**: `g` enters the `g` state for composite commands (`gg`, `gj`, `gk`)
- **Replace**: `r` enters the `replace` state, waiting for the replacement character
- **Indent**: `>`, `<` enter the `indent` state (for `>>` and `<<`)
- **Simple motions**: `h/j/k/l/w/b/e/W/B/E/0/^/$` execute immediately, moving the cursor
- **Immediate commands**: `x` (delete char), `~` (toggle case), `J` (join lines), `p/P` (paste), `D/C/Y` (operator shortcuts), `G` (go to end), `.` (dot-repeat), `;/,` (find repeat), `u` (undo), `i/I/a/A/o/O` (enter insert mode)

### Motions, Operators, and Text Objects

**Motions** are pure functions mapping a key to a cursor position. `resolveMotion(key, cursor, count)` applies the motion `count` times, short-circuiting if the cursor stops moving (you cannot move left past column 0). This short-circuit is important for `3w` at the end of a line -- it stops at the last word rather than wrapping or erroring.

Motions are classified by how they interact with operators:

- **Exclusive** (default) -- the character at the destination is NOT included in the range. `dw` deletes up to but not including the first character of the next word
- **Inclusive** (`e`, `E`, `$`) -- the character at the destination IS included. `de` deletes through the last character of the current word
- **Linewise** (`j`, `k`, `G`, `gg`, `gj`, `gk`) -- when used with operators, the range extends to cover full lines. `dj` deletes the current line and the one below, not just the characters between the two cursor positions

**Operators** apply to a range. `delete` removes text and saves it to the register. `change` removes text and enters insert mode. `yank` copies to the register without modification. The `cw`/`cW` special case follows vim convention: change-word goes to the end of the current word, not the start of the next word (unlike `dw`).

One interesting edge case: `[Image #N]` chip snapping. When a word motion lands inside an image reference chip (rendered as a single visual unit in the terminal), the range extends to cover the entire chip. This prevents partial deletions of what the user perceives as an atomic element -- you cannot delete half of `[Image #3]` because the motion system treats the entire chip as a single word.

Additional commands cover the full expected vim vocabulary: `x` (delete character), `r` (replace character), `~` (toggle case), `J` (join lines), `p`/`P` (paste with linewise/characterwise awareness), `>>` / `<<` (indent/outdent with 2-space stops), `o`/`O` (open line below/above and enter insert mode).

**Text objects** find boundaries around the cursor. They answer the question: "what is the 'thing' the cursor is inside?"

Word objects (`iw`, `aw`, `iW`, `aW`) segment text into graphemes, classify each as word-character, whitespace, or punctuation, and expand the selection to the word boundary. The `i` (inner) variant selects just the word. The `a` (around) variant includes surrounding whitespace -- trailing whitespace preferred, falling back to leading if at line end. The uppercase variants (`W`, `aW`) treat any non-whitespace sequence as a word, ignoring punctuation boundaries.

Quote objects (`i"`, `a"`, `i'`, `a'`, `` i` ``, `` a` ``) find paired quotes on the current line. Pairs are matched in order (first and second quote form a pair, third and fourth form the next pair, etc.). If the cursor is between the first and second quote, that is the match. The `a` variant includes the quote characters; the `i` variant excludes them.

Bracket objects (`ib`/`i(`, `ab`/`a(`, `i[`/`a[`, `iB`/`i{`/`aB`/`a{`, `i<`/`a<`) do depth-tracking search for matching delimiters. They search outward from the cursor, maintaining a nesting count, until they find the matching pair at depth zero. This correctly handles nested brackets -- `d i (` inside `foo((bar))` deletes `bar`, not `(bar)`.

### Persistent State and Dot-Repeat

The vim mode maintains a `PersistentState` that survives across commands -- the "memory" that makes vim feel like vim:

```typescript
interface PersistentState {
  lastChange: RecordedChange;   // For dot-repeat
  lastFind: { type: FindType; char: string };  // For ; and ,
  register: string;             // Yank buffer
  registerIsLinewise: boolean;  // Paste behavior flag
}
```

Every mutating command records itself as a `RecordedChange` -- a discriminated union covering insert, operator+motion, operator+textObj, operator+find, replace, delete-char, toggle-case, indent, open-line, and join. The `.` command replays `lastChange` from persistent state, using the recorded count, operator, and motion to reproduce the exact same edit at the current cursor position.

Find-repeat (`;` and `,`) uses `lastFind`. The `;` command repeats the last find in the same direction. The `,` command flips the direction: `f` becomes `F`, `t` becomes `T`, and vice versa. This means after `fa` (find next 'a'), `;` finds the next 'a' forward and `,` finds the next 'a' backward -- without the user having to remember which direction they were searching.

The register tracks yanked and deleted text. When register content ends with `\n`, it is flagged as linewise, which changes paste behavior: `p` inserts below the current line (not after the cursor), and `P` inserts above. This distinction is invisible to the user but critical for the "delete a line, paste it somewhere else" workflow that vim users rely on constantly.

---

## Virtual Scrolling

Long Claude Code sessions produce long conversations. A heavy debugging session might generate 200+ messages, each containing markdown, code blocks, tool use results, and permission records. Without virtualization, React would maintain 200+ component subtrees in memory, each with its own state, effects, and memoization caches. The DOM tree would contain thousands of nodes. Yoga layout would visit all of them on every frame. The terminal would be unusable.

The `VirtualMessageList` component solves this by rendering only the messages visible in the viewport plus a small buffer above and below. In a conversation with hundreds of messages, this is the difference between mounting 500 React subtrees (each with markdown parsing, syntax highlighting, and tool use blocks) and mounting 15.

The component maintains:

- **Height cache** per message, invalidated when terminal column count changes
- **Jump handle** for transcript search navigation (jump to index, next/previous match)
- **Search text extraction** with warm-cache support (pre-lowercase all messages when the user enters `/`)
- **Sticky prompt tracking** -- when the user scrolls away from the input, their last prompt text appears at the top as context
- **Message actions navigation** -- cursor-based message selection for the rewind feature

The `useVirtualScroll` hook computes which messages to mount based on `scrollTop`, `viewportHeight`, and cumulative message heights. It maintains scroll clamp bounds on the `ScrollBox` to prevent blank screens when burst `scrollTo` calls race past React's async re-render -- a classic problem with virtualized lists where the scroll position can outrun the DOM update.

The interaction between virtual scrolling and the markdown token cache is worth noting. When a message scrolls out of the viewport, its React subtree unmounts. When the user scrolls back, the subtree remounts. Without caching, this would mean re-parsing the markdown for every message the user scrolls past. The module-level LRU cache (500 entries, keyed by content hash) ensures that the expensive `marked.lexer()` call happens at most once per unique message content, regardless of how many times the component mounts and unmounts.

The `ScrollBox` component itself provides an imperative API via `useImperativeHandle`:

- `scrollTo(y)` -- absolute scroll, breaks sticky-scroll mode
- `scrollBy(dy)` -- accumulates into `pendingScrollDelta`, drained by the renderer at a capped rate
- `scrollToElement(el, offset)` -- defers position read to render time via `scrollAnchor`
- `scrollToBottom()` -- re-enables sticky-scroll mode
- `setClampBounds(min, max)` -- constrains the virtual scroll window

All scroll mutations go directly to DOM node properties and schedule renders via microtask, bypassing React's reconciler. The `markScrollActivity()` call signals background intervals (spinners, timers) to skip their next tick, reducing event-loop contention during active scrolling. This is a cooperative scheduling pattern: the scroll path tells background work "I am in a latency-sensitive operation, please yield." Background intervals check this flag before scheduling their next tick and delay by one frame if scrolling is active. The result is consistently smooth scrolling even when multiple spinners and timers are running in the background.

---

## Apply This: Building a Context-Aware Keybinding System

Claude Code's keybinding architecture offers a template for any application with modal input -- editors, IDEs, drawing tools, terminal multiplexers. The key insights:

**Separate bindings from handlers.** Bindings are data (which key maps to which action name). Handlers are code (what happens when the action fires). Keeping them separate means bindings can be serialized to JSON for user customization, while handlers remain in the components that own the relevant state. A user can rebind `ctrl+k` to `chat:submit` without touching any component code.

**Context as a first-class concept.** Instead of one flat keymap, define contexts that activate and deactivate based on application state. When a dialog opens, the `Confirmation` context activates and its bindings take precedence over `Chat` bindings. When the dialog closes, `Chat` bindings resume. This eliminates the conditional soup of `if (dialogOpen && key === 'y')` scattered through event handlers.

**Chord state as an explicit machine.** Multi-key sequences (chords) are not a special case of single-key bindings -- they are a different kind of binding that requires a state machine with timeout and cancellation semantics. Making this explicit (with a dedicated `ChordInterceptor` component and a `pendingChordRef`) prevents subtle bugs where the second keystroke of a chord is consumed by a different handler because React's state update had not yet propagated.

**Reserve early, warn clearly.** Identify keys that cannot be rebound (system shortcuts, terminal control characters) at definition time, not at resolution time. When a user tries to bind `ctrl+c`, show an error during configuration loading rather than silently accepting a binding that will never fire. This is the difference between a keybinding system that works and one that produces mysterious bug reports.

**Design for terminal diversity.** Claude Code's keybinding system defines platform-specific alternatives at the binding level, not the handler level. Image paste is `ctrl+v` or `alt+v` depending on the OS. Mode cycling is `shift+tab` or `meta+m` depending on VT mode support. The handler for each action is the same regardless of which key triggers it. This means testing covers one code path per action, not one per platform-key combination. And when a new terminal quirk surfaces (Windows Terminal lacking VT mode before Node 24.2.0, for example), the fix is a single conditional in the binding definition, not a scattered set of `if (platform === 'windows')` checks in handler code.

**Provide escape hatches.** The null-action unbinding mechanism is small but important. A user who runs Claude Code inside a terminal multiplexer might find that `ctrl+t` (toggle todos) conflicts with their multiplexer's tab-switching shortcut. By adding `{ "ctrl+t": null }` to their keybindings.json, they disable the binding entirely. The key press passes through to the multiplexer. Without null unbinding, the user's only option would be to rebind `ctrl+t` to some other action they do not want, or to reconfigure their multiplexer -- neither of which is a good experience.

The vim mode implementation adds one more lesson: **make the type system enforce your state machine**. The 12-variant `CommandState` union makes it impossible to forget a state in a switch statement. The `TransitionResult` type separates state changes from side effects, making the machine testable as a pure function. If your application has modal input, express the modes as a discriminated union and let the compiler verify exhaustiveness. The time spent defining the types pays for itself in eliminated runtime bugs.

Consider the alternative: a vim implementation using mutable state and imperative conditionals. The `fromOperator` handler would be a nest of `if (mode === 'operator' && pendingCount !== null && isDigit(key))` checks, with each branch mutating shared variables. Adding a new state (say, a macro-recording mode) would require auditing every branch to ensure the new state is handled. With a discriminated union, the compiler does the audit -- the PR that adds the new variant will not build until every switch statement handles it.

This is the deeper lesson of Claude Code's input system: at every layer -- tokenizer, parser, keybinding resolver, vim state machine -- the architecture converts unstructured input into typed, exhaustively handled structures as early as possible. Raw bytes become `ParsedKey` at the parser boundary. `ParsedKey` becomes an action name at the keybinding boundary. The action name becomes a typed handler at the component boundary. Each conversion narrows the space of possible states, and each narrowing is enforced by TypeScript's type system. By the time a keystroke reaches application logic, the ambiguity is gone. There is no "what if the key is undefined?" There is no "what if the modifier combination is impossible?" The types have already forbidden those states from existing.

The two chapters together tell one story. Chapter 13 showed how the rendering system eliminates unnecessary work -- blitting unchanged regions, interning repeated values, diffing at the cell level, tracking damage bounds. Chapter 14 showed how the input system eliminates ambiguity -- parsing five protocols into one type, resolving keys against contextual bindings, expressing modal state as exhaustive unions. The rendering system answers "how do you paint 24,000 cells 60 times per second?" The input system answers "how do you turn a byte stream into meaningful actions across a fragmented ecosystem?" Both answers follow the same principle: push complexity to the boundaries, where it can be handled once and correctly, so that everything downstream operates on clean, typed, well-bounded data. The terminal is chaos. The application is order. The boundary code does the hard work of converting one into the other.

---

## Summary: Two Systems, One Design Philosophy

Chapters 13 and 14 covered the two halves of the terminal interface: output and input. Despite their different concerns, both systems follow the same architectural principles.

**Interning and indirection.** The rendering system interns characters, styles, and hyperlinks into pools, replacing string comparisons with integer comparisons throughout the hot path. The input system interns escape sequences into structured `ParsedKey` objects at the parser boundary, replacing byte-level pattern matching with typed field access throughout the handler path.

**Layered elimination of work.** The rendering system stacks five optimizations (dirty flags, blit, damage rectangles, cell-level diff, patch optimization) that each eliminate a category of unnecessary computation. The input system stacks three (tokenizer, protocol parser, keybinding resolver) that each eliminate a category of ambiguity.

**Pure functions and typed state machines.** The vim mode is a pure state machine with typed transitions. The keybinding resolver is a pure function from (key, contexts, chord-state) to resolution-result. The rendering pipeline is a pure function from (DOM tree, previous screen) to (new screen, patches). Side effects happen at the boundaries -- writing to stdout, dispatching to React -- not in the core logic.

**Graceful degradation across environments.** The rendering system adapts to terminal size, alt-screen support, and synchronized-update protocol availability. The input system adapts to Kitty keyboard protocol, xterm modifyOtherKeys, legacy VT sequences, and multiplexer passthrough requirements. Neither system requires a specific terminal to function; both get better on more capable terminals.

These principles are not specific to terminal applications. They apply to any system that must process high-frequency input and produce low-latency output across a diverse set of runtime environments. The terminal just happens to be an environment where the constraints are sharp enough that violating these principles produces immediately visible degradation -- a dropped frame, a swallowed keystroke, a flicker. That sharpness makes it an excellent teacher.

The next chapter moves from the UI layer to the protocol layer: how Claude Code implements MCP -- the universal tool protocol that lets any external service become a first-class tool. The terminal UI handles the last mile of the user experience -- converting data structures into pixels on a screen and keystrokes into application actions. MCP handles the first mile of extensibility -- discovering, connecting, and executing tools that live outside the agent's own codebase. Between them, the memory system (Chapter 11) and the skills/hooks system (Chapter 12) define the intelligence and control layers. The quality ceiling of the entire system depends on all four: no amount of model intelligence compensates for a laggy UI, and no amount of rendering performance compensates for a model that cannot reach the tools it needs.
