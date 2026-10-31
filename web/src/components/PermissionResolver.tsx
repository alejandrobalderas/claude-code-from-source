import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type ToolType = "read" | "write" | "bash" | "mcp";
type PermissionMode = "bypassPermissions" | "dontAsk" | "auto" | "acceptEdits" | "default" | "plan" | "bubble";
type Resolution = "ALLOWED" | "DENIED" | "ASK_USER";

interface FlowNode {
  id: string;
  label: string;
  detail: string;
  type: "decision" | "result";
}

interface FlowPath {
  nodes: string[];
  result: Resolution;
  explanation: string;
}

interface Preset {
  label: string;
  tool: ToolType;
  mode: PermissionMode;
  hasHook: boolean;
  hookDecision?: Resolution;
}

// --- Data ---

const toolTypes: { value: ToolType; label: string }[] = [
  { value: "read", label: "파일 읽기" },
  { value: "write", label: "파일 쓰기" },
  { value: "bash", label: "배시 명령" },
  { value: "mcp", label: "MCP 도구" },
];

const permissionModes: { value: PermissionMode; label: string; description: string }[] = [
  { value: "bypassPermissions", label: "우회권한", description: "모든 것이 허용됩니다. 수표가 없습니다. 내부/테스트 전용" },
  { value: "dontAsk", label: "묻지 마세요", description: "모두 허용되었으며 여전히 기록되어 있습니다. 사용자 프롬프트 없음" },
  { value: "auto", label: "자동", description: "LLM 성적표 분류자가 허용/거부 결정" },
  { value: "acceptEdits", label: "accept편집", description: "파일 수정이 자동 승인되었습니다. 다른 돌연변이 프롬프트" },
  { value: "default", label: "기본값", description: "표준 대화형 모드. 사용자가 각 작업을 승인합니다." },
  { value: "plan", label: "계획", description: "읽기 전용입니다. 모든 돌연변이가 차단됨" },
  { value: "bubble", label: "거품", description: "상위 상담사에게 결정 에스컬레이션(하위 상담사 모드)" },
];

const presets: Preset[] = [
  { label: "자동 모드에서 파일 읽기", tool: "read", mode: "auto", hasHook: false },
  { label: "계획 모드의 Bash rm", tool: "bash", mode: "plan", hasHook: false },
  { label: "훅 재정의로 쓰기", tool: "write", mode: "default", hasHook: true, hookDecision: "ALLOWED" },
  { label: "기본 모드의 MCP 도구", tool: "mcp", mode: "default", hasHook: false },
  { label: "완전 자동 배쉬(dontAsk)", tool: "bash", mode: "dontAsk", hasHook: false },
  { label: "훅에 의해 쓰기가 차단되었습니다.", tool: "write", mode: "acceptEdits", hasHook: true, hookDecision: "DENIED" },
];

const allNodes: Record<string, FlowNode> = {
  start: { id: "start", label: "도구 호출에 권한이 필요합니다", detail: "tool_use 블록이 모델 응답에서 구문 분석되었습니다.", type: "decision" },
  hookCheck: { id: "hookCheck", label: "훅 규칙 일치?", detail: "PreToolUse 훅가 이 도구 호출과 일치하는지 확인하세요.", type: "decision" },
  hookDecision: { id: "hookDecision", label: "훅 결정 사용", detail: "훅가 허용, 거부 또는 요청을 반환했습니다. 이는 다른 모든 확인보다 우선합니다.", type: "decision" },
  checkPerms: { id: "checkPerms", label: "tool.checkPermissions()", detail: "각 도구는 자체 권한 논리를 정의합니다(읽기 전용 도구는 종종 '허용'을 반환함).", type: "decision" },
  toolAllow: { id: "toolAllow", label: "도구 자체 허용", detail: "checkPermissions()가 '허용'을 반환했습니다. 도구는 본질적으로 안전합니다.", type: "decision" },
  modeCheck: { id: "modeCheck", label: "권한 모드?", detail: "활성 권한 모드를 확인하세요(7개 모드, 최대 허용부터 최소 허용까지).", type: "decision" },
  bypassAllow: { id: "bypassAllow", label: "우회권한/묻지마", detail: "제한이 없습니다. 모든 것은 통과한다", type: "decision" },
  planDeny: { id: "planDeny", label: "계획 모드: 읽기 전용", detail: "모든 돌연변이가 차단됩니다. 읽기 작업만 통과", type: "decision" },
  planReadCheck: { id: "planReadCheck", label: "읽기 작업인가요?", detail: "계획 모드에서는 읽기가 허용되지만 쓰기 및 실행은 차단됩니다.", type: "decision" },
  acceptEditsCheck: { id: "acceptEditsCheck", label: "acceptEdits: 파일 쓰기?", detail: "파일 수정 사항은 자동으로 승인되며, 그 밖의 모든 사항은 사용자에게 메시지가 표시됩니다.", type: "decision" },
  autoClassifier: { id: "autoClassifier", label: "LLM 분류기는 평가합니다.", detail: "경량 LLM 호출은 대화 내용을 기준으로 도구 호출을 분류합니다.", type: "decision" },
  promptUser: { id: "promptUser", label: "사용자에게 프롬프트", detail: "사용자에게 표시되는 내용: 한 번 허용/세션 허용/항상 허용/거부", type: "decision" },
  bubbleUp: { id: "bubbleUp", label: "부모에게 에스컬레이션", detail: "하위 에이전트는 자신의 위험한 행동을 승인할 수 없습니다. 허가가 거품이 난다", type: "decision" },
  resultAllow: { id: "resultAllow", label: "허용됨", detail: "도구 실행이 진행됩니다.", type: "result" },
  resultDeny: { id: "resultDeny", label: "거부됨", detail: "도구 실행이 차단되고 오류가 모델에 반환되었습니다.", type: "result" },
  resultAsk: { id: "resultAsk", label: "사용자에게 문의", detail: "사용자에게 표시되는 대화형 권한 프롬프트", type: "result" },
};

function resolvePermission(
  tool: ToolType,
  mode: PermissionMode,
  hasHook: boolean,
  hookDecision?: Resolution
): FlowPath {
  const nodes: string[] = ["start", "hookCheck"];

  if (hasHook && hookDecision) {
    nodes.push("hookDecision");
    if (hookDecision === "ALLOWED") {
      nodes.push("resultAllow");
      return { nodes, result: "허용됨", explanation: "PreToolUse 훅가 일치하고 반환된 허용 - 다른 모든 검사를 건너뜁니다." };
    }
    if (hookDecision === "DENIED") {
      nodes.push("resultDeny");
      return { nodes, result: "거부됨", explanation: "PreToolUse 훅가 일치하고 거부를 반환했습니다. 권한 메시지가 표시되기 전에 도구가 차단되었습니다." };
    }
    nodes.push("resultAsk");
    return { nodes, result: "ASK_USER", explanation: "PreToolUse 훅가 일치하고 요청이 반환됨 - 사용자가 결정해야 함" };
  }

  nodes.push("checkPerms");

  // Read-only tools self-allow
  if (tool === "read") {
    nodes.push("toolAllow", "resultAllow");
    return { nodes, result: "허용됨", explanation: "읽기 도구의 checkPermissions()가 'allow'를 반환합니다. 읽기 전용 도구는 본질적으로 안전합니다." };
  }

  nodes.push("modeCheck");

  switch (mode) {
    case "bypassPermissions":
    case "dontAsk":
      nodes.push("bypassAllow", "resultAllow");
      return { nodes, result: "허용됨", explanation: `${mode} mode: all tool calls are allowed without prompting` };

    case "plan":
      nodes.push("planDeny");
      if (tool === "read") {
        nodes.push("planReadCheck", "resultAllow");
        return { nodes, result: "허용됨", explanation: "계획 모드에서는 읽기 작업이 가능합니다." };
      }
      nodes.push("resultDeny");
      return { nodes, result: "거부됨", explanation: "계획 모드: 모든 돌연변이가 차단됩니다. 읽기 작업만 허용됩니다." };

    case "acceptEdits":
      nodes.push("acceptEditsCheck");
      if (tool === "write") {
        nodes.push("resultAllow");
        return { nodes, result: "허용됨", explanation: "acceptEdits 모드: 파일 쓰기 작업이 자동으로 승인됩니다." };
      }
      nodes.push("resultAsk");
      return { nodes, result: "ASK_USER", explanation: "acceptEdits 모드: 쓰기가 아닌 작업에는 사용자 승인이 필요합니다." };

    case "auto":
      nodes.push("autoClassifier");
      // For the interactive demo, auto mode allows writes and denies dangerous bash
      if (tool === "bash") {
        nodes.push("resultAsk");
        return { nodes, result: "ASK_USER", explanation: "자동 모드: LLM 분류자가 이 bash 명령을 잠재적으로 안전하지 않은 것으로 표시했습니다." };
      }
      nodes.push("resultAllow");
      return { nodes, result: "허용됨", explanation: "자동 모드: LLM 분류자가 이 작업이 사용자 의도와 일치한다고 판단했습니다." };

    case "default":
      nodes.push("promptUser", "resultAsk");
      return { nodes, result: "ASK_USER", explanation: "기본 모드: 사용자는 각 변형을 대화형으로 승인해야 합니다." };

    case "bubble":
      nodes.push("bubbleUp", "resultAsk");
      return { nodes, result: "ASK_USER", explanation: "버블 모드: 하위 에이전트가 상위 에이전트 또는 사용자에게 권한을 에스컬레이션합니다." };
  }
}

// --- Helpers ---

function useDarkMode() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    window.addEventListener("theme-changed", check);
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("theme-changed", check);
      observer.disconnect();
    };
  }, []);
  return isDark;
}

function ResultBadge({ result, isDark }: { result: Resolution; isDark: boolean }) {
  const config = {
    ALLOWED: {
      bg: isDark ? "rgba(34, 197, 94, 0.15)" : "rgba(34, 197, 94, 0.12)",
      border: "rgba(34, 197, 94, 0.4)",
      color: "#22c55e",
      label: "허용됨",
    },
    DENIED: {
      bg: isDark ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.1)",
      border: "rgba(239, 68, 68, 0.4)",
      color: "#ef4444",
      label: "거부됨",
    },
    ASK_USER: {
      bg: isDark ? "rgba(234, 179, 8, 0.15)" : "rgba(234, 179, 8, 0.1)",
      border: "rgba(234, 179, 8, 0.4)",
      color: "#eab308",
      label: "사용자에게 문의",
    },
  }[result];

  return (
    <motion.span
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      style={{
        display: "inline-block",
        padding: "6px 16px",
        borderRadius: 8,
        background: config.bg,
        border: `1.5px solid ${config.border}`,
        color: config.color,
        fontSize: 14,
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.05em",
      }}
    >
      {config.label}
    </motion.span>
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function PermissionResolver({ className }: Props) {
  const isDark = useDarkMode();
  const [tool, setTool] = useState<ToolType>("write");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [hasHook, setHasHook] = useState(false);
  const [hookDecision, setHookDecision] = useState<Resolution>("ALLOWED");
  const [resolved, setResolved] = useState<FlowPath | null>(null);
  const [animatingIdx, setAnimatingIdx] = useState(-1);
  const abortRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const colors = {
    accent: "#d97757",
    accentDim: "rgba(217, 119, 87, 0.3)",
    accentBg: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.05)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    green: "#22c55e",
    red: "#ef4444",
    amber: "#eab308",
  };

  const reset = useCallback(() => {
    abortRef.current = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setResolved(null);
    setAnimatingIdx(-1);
  }, []);

  const resolve = useCallback(async () => {
    reset();
    await new Promise((r) => setTimeout(r, 50));
    abortRef.current = false;

    const path = resolvePermission(tool, mode, hasHook, hasHook ? hookDecision : undefined);
    setResolved(path);

    // Animate through nodes
    for (let i = 0; i < path.nodes.length; i++) {
      if (abortRef.current) return;
      setAnimatingIdx(i);
      await new Promise<void>((res) => {
        timeoutRef.current = setTimeout(res, 350);
      });
    }
  }, [tool, mode, hasHook, hookDecision, reset]);

  const applyPreset = useCallback((preset: Preset) => {
    reset();
    setTool(preset.tool);
    setMode(preset.mode);
    setHasHook(preset.hasHook);
    if (preset.hookDecision) setHookDecision(preset.hookDecision);
  }, [reset]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const selectStyle = {
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    padding: "6px 10px",
    borderRadius: 6,
    border: `1px solid ${colors.cardBorder}`,
    background: isDark ? "#30302e" : "#f5f4ed",
    color: colors.text,
    cursor: "pointer" as const,
    width: "100%",
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Controls panel */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
            marginBottom: 16,
          }}
        >
          {/* Tool type */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              도구 유형
            </label>
            <select value={tool} onChange={(e) => { setTool(e.target.value as ToolType); reset(); }} style={selectStyle}>
              {toolTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Permission mode */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              권한 모드
            </label>
            <select value={mode} onChange={(e) => { setMode(e.target.value as PermissionMode); reset(); }} style={selectStyle}>
              {permissionModes.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Hook toggle */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              훅 규칙
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: colors.text,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={hasHook}
                  onChange={(e) => { setHasHook(e.target.checked); reset(); }}
                  style={{ accentColor: colors.accent }}
                />
                어울리는 훅 있음
              </label>
              {hasHook && (
                <select
                  value={hookDecision}
                  onChange={(e) => { setHookDecision(e.target.value as Resolution); reset(); }}
                  style={{ ...selectStyle, width: "auto" }}
                >
                  <option value="ALLOWED">허용하다</option>
                  <option value="DENIED">부정하다</option>
                  <option value="ASK_USER">묻다</option>
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Mode description */}
        <div
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            fontFamily: "var(--font-mono)",
            padding: "8px 12px",
            background: isDark ? "rgba(135,134,127,0.08)" : "rgba(135,134,127,0.06)",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {permissionModes.find((m) => m.value === mode)?.description}
        </div>

        {/* Resolve button */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={resolve}
            style={{
              padding: "8px 24px",
              borderRadius: 8,
              border: "none",
              background: colors.accent,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            해결
          </button>

          {resolved && (
            <button
              onClick={reset}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.cardBg,
                color: colors.text,
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              지우기
            </button>
          )}
        </div>
      </div>

      {/* Presets */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            alignSelf: "center",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          사전 설정:
        </span>
        {presets.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.cardBg,
              color: colors.text,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              transition: "border-color 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = colors.accent;
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = colors.cardBorder;
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Decision tree visualization */}
      <AnimatePresence>
        {resolved && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Flow path */}
            <div style={{ position: "relative", paddingLeft: 28 }}>
              {/* Vertical connector */}
              <div
                style={{
                  position: "absolute",
                  left: 14,
                  top: 20,
                  bottom: 20,
                  width: 2,
                  background: colors.cardBorder,
                }}
              />

              {resolved.nodes.map((nodeId, i) => {
                const node = allNodes[nodeId];
                if (!node) return null;

                const isAnimated = i <= animatingIdx;
                const isCurrent = i === animatingIdx;
                const isResult = node.type === "result";

                let dotColor = colors.cardBorder;
                let borderColor = colors.cardBorder;
                let bgColor = colors.cardBg;

                if (isAnimated) {
                  dotColor = colors.accent;
                  borderColor = colors.accent;
                  bgColor = colors.accentBg;
                }
                if (isResult && isAnimated) {
                  if (resolved.result === "ALLOWED") {
                    dotColor = colors.green;
                    borderColor = "rgba(34, 197, 94, 0.4)";
                    bgColor = isDark ? "RGBA(34, 197, 94, 0.08)" : "RGBA(34, 197, 94, 0.05)";
                  } else if (resolved.result === "DENIED") {
                    dotColor = colors.red;
                    borderColor = "rgba(239, 68, 68, 0.4)";
                    bgColor = isDark ? "RGBA(239, 68, 68, 0.08)" : "RGBA(239, 68, 68, 0.05)";
                  } else {
                    dotColor = colors.amber;
                    borderColor = "rgba(234, 179, 8, 0.4)";
                    bgColor = isDark ? "RGBA(234, 179, 8, 0.08)" : "RGBA(234, 179, 8, 0.05)";
                  }
                }

                return (
                  <motion.div
                    key={nodeId + "-" + i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: isAnimated ? 1 : 0.3, x: 0 }}
                    transition={{ duration: 0.3, delay: i * 0.05 }}
                    style={{
                      position: "relative",
                      marginBottom: i < resolved.nodes.length - 1 ? 8 : 0,
                    }}
                  >
                    {/* Dot */}
                    <div
                      style={{
                        position: "absolute",
                        left: -28 + 14 - 5,
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: dotColor,
                        transition: "background 0.3s",
                        zIndex: 1,
                      }}
                    />

                    {/* Pulse on current */}
                    {isCurrent && (
                      <motion.div
                        style={{
                          position: "absolute",
                          left: -28 + 14 - 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: `2px solid ${dotColor}`,
                          zIndex: 0,
                        }}
                        animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                    )}

                    {/* Node card */}
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: `1px solid ${borderColor}`,
                        background: bgColor,
                        transition: "border-color 0.3s, background 0.3s",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!isResult && (
                          <span
                            style={{
                              fontSize: 12,
                              color: isAnimated ? colors.accent : colors.textSecondary,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {node.type === "decision" ? "?" : ""}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: isResult ? 700 : 600,
                            fontFamily: "var(--font-mono)",
                            color: isResult && isAnimated
                              ? dotColor
                              : isAnimated
                                ? colors.accent
                                : colors.text,
                            flex: 1,
                          }}
                        >
                          {node.label}
                        </span>
                        {isResult && isAnimated && (
                          <ResultBadge result={resolved.result} isDark={isDark} />
                        )}
                      </div>

                      {isAnimated && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          transition={{ duration: 0.2 }}
                          style={{ overflow: "hidden" }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              color: colors.textSecondary,
                              marginTop: 4,
                              lineHeight: 1.4,
                            }}
                          >
                            {node.detail}
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Explanation */}
            {animatingIdx >= resolved.nodes.length - 1 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                style={{
                  marginTop: 16,
                  padding: "14px 20px",
                  borderRadius: 12,
                  border: `1px solid ${colors.accentDim}`,
                  background: colors.accentBg,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: colors.text,
                    lineHeight: 1.5,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                      color: colors.accent,
                      marginRight: 8,
                    }}
                  >
                    해결 방법:
                  </span>
                  {resolved.explanation}
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Permission modes reference table */}
      {!resolved && (
        <div
          style={{
            borderRadius: 12,
            border: `1px solid ${colors.cardBorder}`,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              background: isDark ? "rgba(135,134,127,0.08)" : "rgba(135,134,127,0.04)",
              borderBottom: `1px solid ${colors.cardBorder}`,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            권한 모드(가장 허용적인 것부터 가장 낮은 것까지)
          </div>
          {permissionModes.map((m, i) => (
            <div
              key={m.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 16px",
                borderBottom: i < permissionModes.length - 1 ? `1px solid ${colors.cardBorder}` : "none",
                background: mode === m.value ? colors.accentBg : "transparent",
                cursor: "pointer",
                transition: "background 0.2s",
              }}
              onClick={() => { setMode(m.value); reset(); }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  color: mode === m.value ? colors.accent : colors.text,
                  minWidth: 140,
                }}
              >
                {m.label}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                  flex: 1,
                }}
              >
                {m.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
