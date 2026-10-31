# Chapter 16: Remote Control and Cloud Execution

## The Agent Reaches Beyond Localhost

Every chapter so far has assumed that Claude Code runs on the same machine where the code lives. The terminal is local. The filesystem is local. The model responses stream back to a process that owns both the keyboard and the working directory.

That assumption breaks the moment you want to control Claude Code from a browser, run it inside a cloud container, or expose it as a service on your LAN. The agent needs a way to receive instructions from a web browser, a mobile app, or an automated pipeline -- forward permission prompts to someone who is not sitting at the terminal, and tunnel its API traffic through infrastructure that might inject credentials or terminate TLS on the agent's behalf.

Claude Code solves this with four systems, each addressing a different topology:

<div class="diagram-grid">

```mermaid
graph TB
    subgraph "Bridge v1: Poll-Based"
        CLI1[Local CLI] -->|Register| ENV[Environments API]
        ENV -->|Poll for work| CLI1
        CLI1 -->|"WebSocket reads<br/>HTTP POST writes"| WEB1[Web Interface]
    end
```

```mermaid
graph TB
    subgraph "Bridge v2: Direct Sessions"
        CLI2[Local CLI] -->|Create session| SESSION[Session API]
        CLI2 -->|"SSE reads<br/>CCRClient writes"| WEB2[Web Interface]
    end
```

```mermaid
graph TB
    subgraph "Direct Connect"
        CLIENT[Remote Client] -->|"WebSocket (cc:// URL)"| SERVER[Local CLI Server]
    end
```

```mermaid
graph TB
    subgraph "Upstream Proxy"
        CONTAINER[CCR Container] -->|WebSocket tunnel| INFRA[Anthropic Infrastructure]
        INFRA -->|Credential injection| UPSTREAM[Third-Party APIs]
    end
```

</div>

These systems share a common design philosophy: reads and writes are asymmetric, reconnection is automatic, and failures degrade gracefully.

---

## Bridge v1: Poll, Dispatch, Spawn

The v1 bridge is the environment-based remote control system. When a developer runs `claude remote-control`, the CLI registers with the Environments API, polls for work, and spawns a child process per session.

Before registration, a gauntlet of pre-flight checks runs: runtime feature gate, OAuth token validation, organization policy check, dead token detection (a cross-process backoff after three consecutive failures with the same expired token), and proactive token refresh that eliminates roughly 9% of registrations that would otherwise fail on the first attempt.

Once registered, the bridge enters a long-poll loop. Work items arrive as sessions (with a `secret` field containing session tokens, API base URL, MCP configs, and environment variables) or healthchecks. The bridge throttles "no work" log messages to every 100 empty polls.

Each session spawns a child Claude Code process communicating via NDJSON on stdin/stdout. Permission requests flow through the bridge transport to the web interface where the user approves or denies. The round-trip must complete within roughly 10-14 seconds.

---

## Bridge v2: Direct Sessions and SSE

The v2 bridge eliminates the entire Environments API layer -- no registration, no polling, no acknowledgment, no heartbeat, no deregistration. The motivation: v1 required the server to know the machine's capabilities before dispatching work. V2 collapses the lifecycle to three steps:

1. **Create session**: `POST /v1/code/sessions` with OAuth credentials.
2. **Connect bridge**: `POST /v1/code/sessions/{id}/bridge`. Returns a `worker_jwt`, `api_base_url`, and `worker_epoch`. Each `/bridge` call bumps the epoch -- it IS the registration.
3. **Open transport**: SSE for reads, `CCRClient` for writes.

The transport abstraction (`ReplBridgeTransport`) unifies v1 and v2 behind a common interface, so message handling does not need to know which generation it is talking to.

When the SSE connection drops due to a 401, the transport rebuilds with fresh credentials from a new `/bridge` call while preserving the sequence number cursor -- no messages are lost. The write path uses per-instance `getAuthToken` closures instead of process-wide environment variables, preventing JWT leakage across concurrent sessions.

### The FlushGate

A subtle ordering problem: the bridge needs to send conversation history while accepting live writes from the web interface. If a live write arrives during the history flush, messages could be delivered out of order. The `FlushGate` queues live writes during the flush POST and drains them in order when it completes.

### Token Refresh and Epoch Management

The v2 bridge proactively refreshes worker JWTs before expiry. A new epoch tells the server this is the same worker with fresh credentials. Epoch mismatches (409 responses) are handled aggressively: both connections close and an exception unwinds the caller, preventing split-brain scenarios.

---

## Message Routing and Echo Deduplication

Both bridge generations share `handleIngressMessage()` as the central router:

1. Parse JSON, normalize control message keys.
2. Route `control_response` to permission handler, `control_request` to request handler.
3. Check UUID against `recentPostedUUIDs` (echo dedup) and `recentInboundUUIDs` (re-delivery dedup).
4. Forward validated user messages.

### BoundedUUIDSet: O(1) Lookup, O(capacity) Memory

The bridge has an echo problem -- messages may echo back on the read stream or be delivered twice during transport switches. `BoundedUUIDSet` is a FIFO-bounded set backed by a circular buffer:

```typescript
class BoundedUUIDSet {
  private buffer: string[]
  private set: Set<string>
  private head = 0

  add(uuid: string): void {
    if (this.set.size >= this.capacity) {
      this.set.delete(this.buffer[this.head])
    }
    this.buffer[this.head] = uuid
    this.set.add(uuid)
    this.head = (this.head + 1) % this.capacity
  }

  has(uuid: string): boolean { return this.set.has(uuid) }
}
```

Two instances run in parallel, each with capacity 2000. O(1) lookup via the Set, O(capacity) memory via circular buffer eviction, no timers or TTLs. Unknown control request subtypes get an error response, not silence -- preventing the server from waiting for a response that never comes.

---

## The Asymmetric Design: Persistent Reads, HTTP POST Writes

The CCR protocol uses asymmetric transport: reads flow through a persistent connection (WebSocket or SSE), writes go through HTTP POST. This reflects a fundamental asymmetry in the communication pattern.

Reads are high-frequency, low-latency, server-initiated -- hundreds of small messages per second during token streaming. A persistent connection is the only sensible choice. Writes are low-frequency, client-initiated, and require acknowledgment -- messages per minute, not per second. HTTP POST provides reliable delivery, idempotency via UUIDs, and natural integration with load balancers.

Trying to unify them on a single WebSocket creates coupling: if the WebSocket drops during a write, you need retry logic and must distinguish "not sent" from "sent but acknowledgment lost." Separate channels let each be optimized independently.

---

## Remote Session Management

The `SessionsWebSocket` manages the client side of a CCR WebSocket connection. Its reconnection strategy discriminates between failure types:

| Failure | Strategy |
|---------|----------|
| 4003 (unauthorized) | Stop immediately, no retries |
| 4001 (session not found) | Max 3 retries, linear backoff (transient during compaction) |
| Other transient | Exponential backoff, max 5 attempts |

The `isSessionsMessage()` type guard accepts any object with a string `type` field -- deliberately permissive. A hardcoded allowlist would silently drop new message types before the client is updated.

---

## Direct Connect: The Local Server

Direct Connect is the simplest topology: Claude Code runs as a server and clients connect via WebSocket. No cloud intermediary, no OAuth tokens.

Sessions have five states: `starting`, `running`, `detached`, `stopping`, `stopped`. Metadata persists to `~/.claude/server-sessions.json` for resume across server restarts. The `cc://` URL scheme provides clean addressing for local connections.

---

## Upstream Proxy: Credential Injection in Containers

The upstream proxy runs inside CCR containers and solves a specific problem: injecting organization credentials into outbound HTTPS traffic from a container where the agent might execute untrusted commands.

The setup sequence is carefully ordered:

1. Read the session token from `/run/ccr/session_token`.
2. Set `prctl(PR_SET_DUMPABLE, 0)` via Bun FFI -- blocking same-UID ptrace of the process heap. Without this, a prompt-injected `gdb -p $PPID` could scrape the token from memory.
3. Download the upstream proxy CA certificate and concatenate with system CA bundle.
4. Start a local CONNECT-to-WebSocket relay on an ephemeral port.
5. Unlink the token file -- the token now exists only on the heap.
6. Export environment variables for all subprocesses.

Every step fails open: errors disable the proxy rather than killing the session. The correct tradeoff -- a failed proxy means some integrations will not work, but core functionality remains available.

### Protobuf Hand-Encoding

Bytes through the tunnel are wrapped in `UpstreamProxyChunk` protobuf messages. The schema is trivial -- `message UpstreamProxyChunk { bytes data = 1; }` -- and Claude Code encodes it by hand in ten lines rather than pulling in a protobuf runtime:

```typescript
export function encodeChunk(data: Uint8Array): Uint8Array {
  const varint: number[] = []
  let n = data.length
  while (n > 0x7f) { varint.push((n & 0x7f) | 0x80); n >>>= 7 }
  varint.push(n)
  const out = new Uint8Array(1 + varint.length + data.length)
  out[0] = 0x0a  // field 1, wire type 2
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}
```

Ten lines replace a full protobuf runtime. A single-field message does not justify a dependency -- the maintenance burden of the bit manipulation is far lower than the supply chain risk.

---

## Apply This: Designing Remote Agent Execution

**Separate read and write channels.** When reads are high-frequency streams and writes are low-frequency RPCs, unifying them creates unnecessary coupling. Let each channel fail and recover independently.

**Bound your deduplication memory.** The BoundedUUIDSet pattern provides fixed-memory deduplication. Any at-least-once delivery system needs a bounded dedup buffer, not an unbounded Set.

**Make reconnection strategy proportional to the failure signal.** Permanent failures should not retry. Transient failures should retry with backoff. Ambiguous failures should retry with a low cap.

**Keep secrets heap-only in adversarial environments.** Reading the token from a file, disabling ptrace, and unlinking the file eliminates both filesystem and memory-inspection attack vectors.

**Fail open for auxiliary systems.** The upstream proxy fails open because it provides enhanced functionality (credential injection), not core functionality (model inference).

The remote execution systems encode a deeper principle: the agent's core loop (Chapter 5) should be agnostic about where instructions come from and where results go. The bridge, Direct Connect, and upstream proxy are transport layers. The message handling, tool execution, and permission flows above them are identical regardless of whether the user is sitting at the terminal or on the other side of a WebSocket.

The next chapter examines the other operational concern: performance -- how Claude Code makes every millisecond and token count across startup, rendering, search, and API costs.
