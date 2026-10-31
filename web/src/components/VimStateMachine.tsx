import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type VimMode = "NORMAL" | "INSERT";
type PendingState =
  | "none"
  | "operator"
  | "count"
  | "operator_count";

interface MachineState {
  mode: VimMode;
  pending: PendingState;
  operator: string | null;
  count: number | null;
  buffer: string;
}

interface EditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  yankBuffer: string[];
}

interface CommandLogEntry {
  keys: string;
  description: string;
  timestamp: number;
}

interface TransitionAnimation {
  from: string;
  to: string;
  label: string;
  timestamp: number;
}

// --- Constants ---

const SAMPLE_TEXT = [
  "function processQuery(messages) {",
  "  const context = buildContext(messages);",
  "  const response = streamModel(context);",
  "  return parseToolCalls(response);",
  "}",
];

const OPERATORS = new Set(["d", "c", "y"]);
const MOTIONS = new Set(["w", "b", "e", "0", "$"]);

const PRESET_SEQUENCES = [
  { keys: "dd", label: "dd", description: "줄 삭제" },
  { keys: "d2w", label: "d2w", description: "단어 2개 삭제" },
  { keys: "cw", label: "CW", description: "단어 변경" },
  { keys: "3dd", label: "3dd", description: "3줄 삭제" },
  { keys: "yy", label: "응", description: "양크 라인" },
  { keys: "p", label: "p", description: "붙여넣기" },
];

// --- State Diagram Layout ---

interface StateNode {
  id: string;
  label: string;
  x: number;
  y: number;
  sublabel?: string;
}

interface StateEdge {
  from: string;
  to: string;
  label: string;
  curveOffset?: number;
}

const STATE_NODES: StateNode[] = [
  { id: "NORMAL", label: "일반", x: 160, y: 60 },
  { id: "INSERT", label: "삽입", x: 430, y: 60 },
  { id: "OPERATOR", label: "운영자", sublabel: "보류 중", x: 100, y: 190 },
  { id: "COUNT", label: "개수", sublabel: "보류 중", x: 295, y: 190 },
  { id: "OP_COUNT", label: "연산+개수", sublabel: "보류 중", x: 200, y: 300 },
];

const STATE_EDGES: StateEdge[] = [
  { from: "NORMAL", to: "INSERT", label: "나, c+모션" },
  { from: "INSERT", to: "NORMAL", label: "Esc" },
  { from: "NORMAL", to: "OPERATOR", label: "d, c, y" },
  { from: "NORMAL", to: "COUNT", label: "1-9" },
  { from: "OPERATOR", to: "NORMAL", label: "동작, 반복" },
  { from: "OPERATOR", to: "OP_COUNT", label: "1-9" },
  { from: "COUNT", to: "OPERATOR", label: "d, c, y" },
  { from: "OP_COUNT", to: "NORMAL", label: "모션" },
];

function getActiveStateId(machine: MachineState): string {
  if (machine.mode === "INSERT") return "INSERT";
  switch (machine.pending) {
    case "operator":
      return "OPERATOR";
    case "count":
      return "COUNT";
    case "operator_count":
      return "OP_COUNT";
    default:
      return "NORMAL";
  }
}

// --- Vim Logic ---

function wordBoundary(line: string, col: number, direction: "forward" | "backward"): number {
  if (direction === "forward") {
    let i = col;
    // Skip current word chars
    while (i < line.length && /\w/.test(line[i]!)) i++;
    // Skip whitespace
    while (i < line.length && /\s/.test(line[i]!)) i++;
    return Math.min(i, Math.max(0, line.length - 1));
  } else {
    let i = col - 1;
    // Skip whitespace
    while (i > 0 && /\s/.test(line[i]!)) i--;
    // Skip word chars
    while (i > 0 && /\w/.test(line[i - 1]!)) i--;
    return Math.max(0, i);
  }
}

function wordEnd(line: string, col: number): number {
  let i = col + 1;
  // Skip whitespace
  while (i < line.length && /\s/.test(line[i]!)) i++;
  // Go to end of word
  while (i < line.length - 1 && /\w/.test(line[i + 1]!)) i++;
  return Math.min(i, Math.max(0, line.length - 1));
}

function applyMotion(
  editor: EditorState,
  motion: string,
  _count: number
): { line: number; col: number } {
  const count = _count || 1;
  let { cursorLine: line, cursorCol: col } = editor;
  const currentLine = editor.lines[line] || "";

  for (let i = 0; i < count; i++) {
    switch (motion) {
      case "w":
        col = wordBoundary(currentLine, col, "forward");
        break;
      case "b":
        col = wordBoundary(currentLine, col, "backward");
        break;
      case "e":
        col = wordEnd(currentLine, col);
        break;
      case "0":
        col = 0;
        break;
      case "$":
        col = Math.max(0, currentLine.length - 1);
        break;
    }
  }

  return { line, col };
}

function executeCommand(
  editor: EditorState,
  operator: string | null,
  motion: string | null,
  count: number | null
): { editor: EditorState; description: string; toInsert: boolean } {
  const c = count || 1;
  const newEditor = {
    ...editor,
    lines: [...editor.lines],
    yankBuffer: [...editor.yankBuffer],
  };
  let description = "";
  let toInsert = false;

  if (operator === "d" && motion === null) {
    // dd — delete lines
    const deleteCount = Math.min(c, newEditor.lines.length - newEditor.cursorLine);
    const deleted = newEditor.lines.splice(newEditor.cursorLine, deleteCount);
    newEditor.yankBuffer = deleted;
    if (newEditor.lines.length === 0) newEditor.lines = [""];
    newEditor.cursorLine = Math.min(newEditor.cursorLine, newEditor.lines.length - 1);
    newEditor.cursorCol = 0;
    description = c > 1 ? `delete ${c} lines` : "delete line";
  } else if (operator === "y" && motion === null) {
    // yy — yank lines
    const yankCount = Math.min(c, newEditor.lines.length - newEditor.cursorLine);
    newEditor.yankBuffer = newEditor.lines.slice(
      newEditor.cursorLine,
      newEditor.cursorLine + yankCount
    );
    description = c > 1 ? `yank ${c} lines` : "yank line";
  } else if (operator === "d" && motion) {
    // d + motion — delete to motion target
    const target = applyMotion(newEditor, motion, c);
    const line = newEditor.lines[newEditor.cursorLine] || "";
    const start = Math.min(newEditor.cursorCol, target.col);
    const end = Math.max(newEditor.cursorCol, target.col);
    const deleted = line.slice(start, end);
    newEditor.lines[newEditor.cursorLine] = line.slice(0, start) + line.slice(end);
    newEditor.yankBuffer = [deleted];
    newEditor.cursorCol = start;
    description = c > 1 ? `delete ${c} ${motionName(motion)}s` : `delete ${motionName(motion)}`;
  } else if (operator === "c" && motion) {
    // c + motion — change to motion target, enter INSERT
    const target = applyMotion(newEditor, motion, c);
    const line = newEditor.lines[newEditor.cursorLine] || "";
    const start = Math.min(newEditor.cursorCol, target.col);
    const end = Math.max(newEditor.cursorCol, target.col);
    newEditor.lines[newEditor.cursorLine] = line.slice(0, start) + line.slice(end);
    newEditor.cursorCol = start;
    toInsert = true;
    description = c > 1 ? `change ${c} ${motionName(motion)}s` : `change ${motionName(motion)}`;
  } else if (operator === "y" && motion) {
    // y + motion — yank to motion target
    const target = applyMotion(newEditor, motion, c);
    const line = newEditor.lines[newEditor.cursorLine] || "";
    const start = Math.min(newEditor.cursorCol, target.col);
    const end = Math.max(newEditor.cursorCol, target.col);
    newEditor.yankBuffer = [line.slice(start, end)];
    description = c > 1 ? `yank ${c} ${motionName(motion)}s` : `yank ${motionName(motion)}`;
  }

  return { editor: newEditor, description, toInsert };
}

function motionName(m: string): string {
  switch (m) {
    case "w": return "word";
    case "b": return "word back";
    case "e": return "word end";
    case "0": return "line start";
    case "$": return "line end";
    default: return m;
  }
}

// --- Component ---

export default function VimStateMachine({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  const [machine, setMachine] = useState<MachineState>({
    mode: "NORMAL",
    pending: "none",
    operator: null,
    count: null,
    buffer: "",
  });

  const [editor, setEditor] = useState<EditorState>({
    lines: [...SAMPLE_TEXT],
    cursorLine: 0,
    cursorCol: 0,
    yankBuffer: [],
  });

  const [commandLog, setCommandLog] = useState<CommandLogEntry[]>([]);
  const [pendingDisplay, setPendingDisplay] = useState<string>("");
  const [activeTransition, setActiveTransition] = useState<TransitionAnimation | null>(null);
  const [playingPreset, setPlayingPreset] = useState(false);

  const addLog = useCallback((keys: string, description: string) => {
    setCommandLog((prev) => [
      { keys, description, timestamp: Date.now() },
      ...prev.slice(0, 9),
    ]);
  }, []);

  const triggerTransition = useCallback((from: string, to: string, label: string) => {
    setActiveTransition({ from, to, label, timestamp: Date.now() });
    setTimeout(() => setActiveTransition(null), 600);
  }, []);

  const resetAll = useCallback(() => {
    setMachine({
      mode: "NORMAL",
      pending: "none",
      operator: null,
      count: null,
      buffer: "",
    });
    setEditor({
      lines: [...SAMPLE_TEXT],
      cursorLine: 0,
      cursorCol: 0,
      yankBuffer: [],
    });
    setCommandLog([]);
    setPendingDisplay("");
    setActiveTransition(null);
  }, []);

  const processKey = useCallback(
    (key: string) => {
      const prevStateId = getActiveStateId(machine);

      setMachine((m) => {
        const newM = { ...m };

        // Escape always goes to NORMAL
        if (key === "Escape") {
          newM.mode = "NORMAL";
          newM.pending = "none";
          newM.operator = null;
          newM.count = null;
          newM.buffer = "";
          setPendingDisplay("");
          if (m.mode === "INSERT" || m.pending !== "none") {
            addLog("Esc", m.mode === "INSERT" ? "exit insert mode" : "cancel pending");
            const fromId = prevStateId;
            triggerTransition(fromId, "NORMAL", "Esc");
          }
          return newM;
        }

        // INSERT mode — just show text typing (simplified)
        if (m.mode === "INSERT") {
          if (key.length === 1) {
            setEditor((ed) => {
              const newEd = { ...ed, lines: [...ed.lines] };
              const line = newEd.lines[newEd.cursorLine] || "";
              newEd.lines[newEd.cursorLine] =
                line.slice(0, newEd.cursorCol) + key + line.slice(newEd.cursorCol);
              newEd.cursorCol += 1;
              return newEd;
            });
          }
          return newM;
        }

        // NORMAL mode processing
        const isDigit = /^[1-9]$/.test(key);
        const isZero = key === "0";
        const isOperator = OPERATORS.has(key);
        const isMotion = MOTIONS.has(key);

        // Special single-key commands
        if (m.pending === "none") {
          if (key === "i") {
            newM.mode = "INSERT";
            newM.buffer = "";
            setPendingDisplay("");
            addLog("i", "enter insert mode");
            triggerTransition("NORMAL", "INSERT", "i");
            return newM;
          }
          if (key === "x") {
            setEditor((ed) => {
              const newEd = { ...ed, lines: [...ed.lines] };
              const line = newEd.lines[newEd.cursorLine] || "";
              if (line.length > 0) {
                newEd.lines[newEd.cursorLine] =
                  line.slice(0, newEd.cursorCol) + line.slice(newEd.cursorCol + 1);
                newEd.cursorCol = Math.min(
                  newEd.cursorCol,
                  Math.max(0, (newEd.lines[newEd.cursorLine] || "").length - 1)
                );
              }
              return newEd;
            });
            addLog("x", "delete character");
            return newM;
          }
          if (key === "p") {
            setEditor((ed) => {
              const newEd = { ...ed, lines: [...ed.lines] };
              if (newEd.yankBuffer.length > 0) {
                // Line-wise paste if buffer looks like full lines
                if (newEd.yankBuffer.length > 0 && newEd.yankBuffer[0]!.includes(" ")) {
                  // Paste after current line
                  newEd.lines.splice(newEd.cursorLine + 1, 0, ...newEd.yankBuffer);
                  newEd.cursorLine += 1;
                  newEd.cursorCol = 0;
                } else {
                  // Inline paste
                  const line = newEd.lines[newEd.cursorLine] || "";
                  const text = newEd.yankBuffer.join("\n");
                  newEd.lines[newEd.cursorLine] =
                    line.slice(0, newEd.cursorCol + 1) + text + line.slice(newEd.cursorCol + 1);
                  newEd.cursorCol += text.length;
                }
              }
              return newEd;
            });
            addLog("p", "paste");
            return newM;
          }

          // Pure motion in normal mode
          if (isMotion || (isZero && m.pending === "none")) {
            const motionKey = isZero ? "0" : key;
            setEditor((ed) => {
              const target = applyMotion(ed, motionKey, 1);
              return { ...ed, cursorLine: target.line, cursorCol: target.col };
            });
            addLog(key, `move: ${motionName(motionKey)}`);
            return newM;
          }
        }

        // Count starting (no pending operator)
        if (isDigit && m.pending === "none") {
          newM.pending = "count";
          newM.count = parseInt(key);
          newM.buffer = key;
          setPendingDisplay(`${key} (count: ${key} -- waiting for operator or motion...)`);
          triggerTransition("NORMAL", "COUNT", key);
          return newM;
        }

        // More digits for count
        if (isDigit && (m.pending === "count" || m.pending === "operator_count")) {
          const newCount = (m.count || 0) * 10 + parseInt(key);
          newM.count = newCount;
          newM.buffer = m.buffer + key;
          if (m.pending === "count") {
            setPendingDisplay(`${newM.buffer} (count: ${newCount} -- waiting for operator or motion...)`);
          } else {
            setPendingDisplay(
              `${newM.buffer} (operator: ${m.operator}, count: ${newCount} -- waiting for motion...)`
            );
          }
          return newM;
        }

        // Operator after count
        if (isOperator && m.pending === "count") {
          newM.pending = "operator";
          newM.operator = key;
          newM.buffer = m.buffer + key;
          setPendingDisplay(
            `${newM.buffer} (count: ${m.count}, operator: ${operatorName(key)} -- waiting for motion...)`
          );
          triggerTransition("COUNT", "OPERATOR", key);
          return newM;
        }

        // Operator from normal
        if (isOperator && m.pending === "none") {
          newM.pending = "operator";
          newM.operator = key;
          newM.buffer = key;
          setPendingDisplay(`${key} (operator: ${operatorName(key)} -- waiting for motion...)`);
          triggerTransition("NORMAL", "OPERATOR", key);
          return newM;
        }

        // Digit after operator
        if (isDigit && m.pending === "operator") {
          newM.pending = "operator_count";
          newM.count = parseInt(key);
          newM.buffer = m.buffer + key;
          setPendingDisplay(
            `${newM.buffer} (operator: ${operatorName(m.operator!)}, count: ${key} -- waiting for motion...)`
          );
          triggerTransition("OPERATOR", "OP_COUNT", key);
          return newM;
        }

        // Repeat operator (dd, yy, cc)
        if (isOperator && m.pending === "operator" && key === m.operator) {
          const totalCount = m.count || 1;
          const fullBuffer = m.buffer + key;
          const result = executeCommand(
            // Use a snapshot for the execution
            undefined as unknown as EditorState, // placeholder
            m.operator,
            null,
            totalCount
          );
          // We need editor state, so do it in setEditor
          setEditor((ed) => {
            const res = executeCommand(ed, m.operator, null, totalCount);
            addLog(fullBuffer, res.description);
            if (res.toInsert) {
              // Will be set below
            }
            return res.editor;
          });
          // Check if we go to insert (cc)
          const goInsert = m.operator === "c";
          newM.mode = goInsert ? "INSERT" : "NORMAL";
          newM.pending = "none";
          newM.operator = null;
          newM.count = null;
          newM.buffer = "";
          setPendingDisplay("");
          triggerTransition("OPERATOR", goInsert ? "INSERT" : "NORMAL", key + key);
          return newM;
        }

        // Motion after operator (with optional count)
        if (isMotion && (m.pending === "operator" || m.pending === "operator_count")) {
          const totalCount = m.count || 1;
          const fullBuffer = m.buffer + key;
          setEditor((ed) => {
            const res = executeCommand(ed, m.operator, key, totalCount);
            addLog(fullBuffer, res.description);
            return res.editor;
          });
          const goInsert = m.operator === "c";
          newM.mode = goInsert ? "INSERT" : "NORMAL";
          newM.pending = "none";
          newM.operator = null;
          newM.count = null;
          newM.buffer = "";
          setPendingDisplay("");
          const fromId = m.pending === "operator_count" ? "OP_COUNT" : "OPERATOR";
          triggerTransition(fromId, goInsert ? "INSERT" : "NORMAL", key);
          return newM;
        }

        // Motion after count (no operator — just move with count)
        if (isMotion && m.pending === "count") {
          const totalCount = m.count || 1;
          const fullBuffer = m.buffer + key;
          setEditor((ed) => {
            const target = applyMotion(ed, key, totalCount);
            return { ...ed, cursorLine: target.line, cursorCol: target.col };
          });
          addLog(fullBuffer, `move: ${totalCount}x ${motionName(key)}`);
          newM.pending = "none";
          newM.count = null;
          newM.buffer = "";
          setPendingDisplay("");
          triggerTransition("COUNT", "NORMAL", key);
          return newM;
        }

        return newM;
      });
    },
    [machine, addLog, triggerTransition]
  );

  // Keyboard handler
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e.key === "Escape" ? "Escape" : e.key;
      if (key.length === 1 || key === "Escape") {
        processKey(key);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focused, processKey]);

  const playPreset = useCallback(
    async (keys: string) => {
      if (playingPreset) return;
      setPlayingPreset(true);
      // Reset to clean NORMAL state first
      setMachine({
        mode: "NORMAL",
        pending: "none",
        operator: null,
        count: null,
        buffer: "",
      });
      setPendingDisplay("");

      for (let i = 0; i < keys.length; i++) {
        await new Promise((r) => setTimeout(r, 400));
        processKey(keys[i]!);
      }
      setPlayingPreset(false);
    },
    [processKey, playingPreset]
  );

  const activeStateId = getActiveStateId(machine);

  return (
    <div
      ref={containerRef}
      className={`select-none ${className || ""}`}
      onClick={() => {
        setFocused(true);
        containerRef.current?.focus();
      }}
      onBlur={(e) => {
        // Only unfocus if clicking outside the component entirely
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          setFocused(false);
        }
      }}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      {/* Focus indicator */}
      <div
        className="rounded-xl border-2 transition-colors duration-200 overflow-hidden"
        style={{
          borderColor: focused ? "#d97757" : "transparent",
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-2 flex items-center justify-between text-sm"
          style={{ backgroundColor: "#1e1e1c", color: "#87867f" }}
        >
          <div className="flex items-center gap-2">
            <span
              className="font-mono font-bold text-xs px-2 py-0.5 rounded"
              style={{
                backgroundColor:
                  machine.mode === "INSERT" ? "#2d6a4f" : "#d97757",
                color: "#f5f4ed",
              }}
            >
              -- {machine.mode} --
            </span>
            {!focused && (
              <span className="text-xs opacity-70">클릭하여 초점을 맞추고 vim 명령을 입력하세요.</span>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              resetAll();
            }}
            className="text-xs px-2 py-0.5 rounded transition-colors hover:opacity-80"
            style={{
              backgroundColor: "#30302e",
              color: "#c2c0b6",
            }}
          >
            재설정
          </button>
        </div>

        {/* State Diagram */}
        <div style={{ backgroundColor: "#262624", minHeight: 200 }}>
          <svg
            viewBox="0 0 530 340"
            className="w-full"
            style={{ maxHeight: 260, minHeight: 180 }}
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 7"
                refX="10"
                refY="3.5"
                markerWidth="8"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#87867f" />
              </marker>
              <marker
                id="arrow-active"
                viewBox="0 0 10 7"
                refX="10"
                refY="3.5"
                markerWidth="8"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#d97757" />
              </marker>
            </defs>

            {/* Edges */}
            {STATE_EDGES.map((edge, i) => {
              const from = STATE_NODES.find((n) => n.id === edge.from)!;
              const to = STATE_NODES.find((n) => n.id === edge.to)!;
              const isActive =
                activeTransition &&
                activeTransition.from === edge.from &&
                activeTransition.to === edge.to;

              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const nx = dx / len;
              const ny = dy / len;

              // Offset start/end to avoid overlap with circles
              const r = 30;
              const sx = from.x + nx * r;
              const sy = from.y + ny * r;
              const ex = to.x - nx * r;
              const ey = to.y - ny * r;

              // Curve for bidirectional edges
              const offset = edge.curveOffset || 0;
              // Check if there is a reverse edge
              const hasReverse = STATE_EDGES.some(
                (e2) => e2.from === edge.to && e2.to === edge.from
              );
              const curveAmount = hasReverse ? 25 : 0;
              const perpX = -ny * curveAmount;
              const perpY = nx * curveAmount;
              const mx = (sx + ex) / 2 + perpX + offset;
              const my = (sy + ey) / 2 + perpY + offset;

              const pathD =
                curveAmount !== 0
                  ? `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`
                  : `M ${sx} ${sy} L ${ex} ${ey}`;

              // Label position
              const lx = curveAmount !== 0 ? mx : (sx + ex) / 2;
              const ly = curveAmount !== 0 ? my : (sy + ey) / 2;

              return (
                <g key={i}>
                  <path
                    d={pathD}
                    fill="none"
                    stroke={isActive ? "#d97757" : "#555"}
                    strokeWidth={isActive ? 2.5 : 1.5}
                    markerEnd={isActive ? "url(#arrow-active)" : "url(#arrow)"}
                    style={{
                      transition: "stroke 0.3s, stroke-width 0.3s",
                    }}
                  />
                  {isActive && (
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#d97757"
                      strokeWidth={2.5}
                      opacity={0.4}
                      strokeDasharray="4 4"
                    >
                      <animate
                        attributeName="stroke-dashoffset"
                        from="8"
                        to="0"
                        dur="0.4s"
                        repeatCount="indefinite"
                      />
                    </path>
                  )}
                  <text
                    x={lx}
                    y={ly - 6}
                    textAnchor="middle"
                    fill={isActive ? "#d97757" : "#87867f"}
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                    style={{ transition: "fill 0.3s" }}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {STATE_NODES.map((node) => {
              const isActive = activeStateId === node.id;
              const isMain = node.id === "NORMAL" || node.id === "INSERT";

              return (
                <g key={node.id}>
                  {isActive && (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={isMain ? 34 : 30}
                      fill="none"
                      stroke="#d97757"
                      strokeWidth={2}
                      opacity={0.3}
                    >
                      <animate
                        attributeName="r"
                        values={isMain ? "34;40;34" : "30;36;30"}
                        dur="1.5s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="opacity"
                        values="0.3;0.1;0.3"
                        dur="1.5s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={isMain ? 32 : 28}
                    fill={isActive ? "#d97757" : "#30302e"}
                    stroke={isActive ? "#d97757" : "#555"}
                    strokeWidth={isActive ? 2.5 : 1.5}
                    style={{ transition: "fill 0.3s, stroke 0.3s" }}
                  />
                  <text
                    x={node.x}
                    y={node.sublabel ? node.y - 4 : node.y + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={isActive ? "#f5f4ed" : "#c2c0b6"}
                    fontSize={isMain ? "13" : "11"}
                    fontFamily="var(--font-mono)"
                    fontWeight="600"
                    style={{ transition: "fill 0.3s" }}
                  >
                    {node.label}
                  </text>
                  {node.sublabel && (
                    <text
                      x={node.x}
                      y={node.y + 10}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={isActive ? "#f5f4ed" : "#87867f"}
                      fontSize="9"
                      fontFamily="var(--font-mono)"
                      style={{ transition: "fill 0.3s" }}
                    >
                      {node.sublabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Editor */}
        <div
          className="font-mono text-sm leading-6 p-4 relative"
          style={{
            backgroundColor: "#1e1e1c",
            color: "#f5f4ed",
            minHeight: 160,
          }}
        >
          <div className="absolute top-2 right-3 text-xs" style={{ color: "#555" }}>
            {editor.cursorLine + 1}:{editor.cursorCol + 1}
          </div>
          {editor.lines.map((line, lineIdx) => (
            <div key={lineIdx} className="flex">
              <span
                className="w-8 text-right pr-3 select-none shrink-0"
                style={{ color: "#555" }}
              >
                {lineIdx + 1}
              </span>
              <span className="whitespace-pre">
                {line.split("").map((ch, colIdx) => {
                  const isCursor =
                    lineIdx === editor.cursorLine &&
                    colIdx === editor.cursorCol;
                  return (
                    <span
                      key={colIdx}
                      style={
                        isCursor
                          ? {
                              backgroundColor: "#d97757",
                              color: "#1e1e1c",
                              animation: "vim-blink 1s step-end infinite",
                            }
                          : undefined
                      }
                    >
                      {ch}
                    </span>
                  );
                })}
                {/* Show cursor at end of line */}
                {lineIdx === editor.cursorLine &&
                  editor.cursorCol >= line.length && (
                    <span
                      style={{
                        backgroundColor: "#d97757",
                        color: "#1e1e1c",
                        animation: "vim-blink 1s step-end infinite",
                      }}
                    >
                      {" "}
                    </span>
                  )}
              </span>
            </div>
          ))}
          <style>{"@keyframes vim-blink {\n              0%, 100% { 불투명도: 1; }\n              50% { 불투명도: 0.3; }\n            }"}</style>
        </div>

        {/* Command Buffer */}
        <div
          className="px-4 py-3 border-t"
          style={{
            backgroundColor: "#262624",
            borderColor: "#333",
          }}
        >
          {/* Pending display */}
          <div
            className="font-mono text-sm min-h-[24px] mb-2"
            style={{ color: "#c2c0b6" }}
          >
            {pendingDisplay ? (
              <span>
                {pendingDisplay.split("").map((ch, i) => {
                  const key = `${ch}-${i}`;
                  if (OPERATORS.has(ch) && i < (machine.buffer?.length || 0)) {
                    return (
                      <span key={key} style={{ color: "#d97757", fontWeight: 600 }}>
                        {ch}
                      </span>
                    );
                  }
                  if (/[0-9]/.test(ch) && i < (machine.buffer?.length || 0)) {
                    return (
                      <span key={key} style={{ color: "#6ba3d6" }}>
                        {ch}
                      </span>
                    );
                  }
                  return <span key={key}>{ch}</span>;
                })}
              </span>
            ) : (
              <span style={{ color: "#555" }}>
                {focused ? "vim 명령을 입력하세요..." : "클릭하여 집중하세요"}
              </span>
            )}
          </div>

          {/* Recent commands */}
          <AnimatePresence>
            {commandLog.slice(0, 4).map((entry) => (
              <motion.div
                key={entry.timestamp}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="font-mono text-xs flex gap-3 mb-1"
              >
                <span style={{ color: "#d97757" }}>{entry.keys}</span>
                <span style={{ color: "#87867f" }}>{entry.description}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Presets */}
        <div
          className="px-4 py-3 flex flex-wrap items-center gap-2 border-t"
          style={{
            backgroundColor: "#1e1e1c",
            borderColor: "#333",
          }}
        >
          <span className="text-xs mr-1" style={{ color: "#87867f" }}>
            시도해 보세요:
          </span>
          {PRESET_SEQUENCES.map((preset) => (
            <button
              key={preset.keys}
              onClick={(e) => {
                e.stopPropagation();
                setFocused(true);
                playPreset(preset.keys);
              }}
              disabled={playingPreset}
              className="text-xs font-mono px-2 py-1 rounded transition-all hover:scale-105 disabled:opacity-40"
              style={{
                backgroundColor: "#30302e",
                color: "#f5f4ed",
                border: "1px solid #444",
              }}
              title={preset.description}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function operatorName(op: string): string {
  switch (op) {
    case "d":
      return "delete";
    case "c":
      return "change";
    case "y":
      return "yank";
    default:
      return op;
  }
}
