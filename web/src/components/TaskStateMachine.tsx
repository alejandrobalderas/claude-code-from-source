import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

type CommunicationPattern = "foreground" | "background" | "coordinator";

interface Transition {
  from: TaskStatus;
  to: TaskStatus;
  label: string;
  trigger: string;
  detail: string;
}

// --- Data ---

const transitions: Transition[] = [
  {
    from: "pending",
    to: "running",
    label: "실행이 시작됩니다",
    trigger: "작업이 등록되고 첫 번째 실행이 시작됩니다.",
    detail:
      "등록과 첫 번째 실행 사이의 간략한 상태입니다. 에이전트 루프 또는 셸 프로세스가 시작되면 작업이 실행 중으로 이동합니다.",
  },
  {
    from: "running",
    to: "completed",
    label: "정상적인 마무리",
    trigger: "에이전트가 작업을 성공적으로 완료하거나 쉘이 0을 종료합니다.",
    detail:
      "작업이 결과를 낳았습니다. 디스크 파일에 출력이 기록됩니다. 부모에게 알리면 알림 플래그가 참으로 전환됩니다.",
  },
  {
    from: "running",
    to: "failed",
    label: "오류",
    trigger: "처리되지 않은 예외, API 오류 또는 도구 오류",
    detail:
      "오류로 인해 실행이 종료되었습니다. 오류는 작업 출력 파일에 캡처되고 작업 알림 XML을 통해 보고됩니다.",
  },
  {
    from: "running",
    to: "killed",
    label: "중단/사용자 중지",
    trigger: "사용자가 ESC를 누르거나 코디네이터가 TaskStop을 호출하거나 신호를 중단함",
    detail:
      "명시적으로 중지되었습니다. 중단 컨트롤러가 실행되고 finally 블록에서 정리가 실행됩니다. 결과가 생성되지 않습니다.",
  },
];

const statusPositions: Record<TaskStatus, { x: number; y: number }> = {
  pending: { x: 80, y: 100 },
  running: { x: 280, y: 100 },
  completed: { x: 480, y: 40 },
  failed: { x: 480, y: 100 },
  killed: { x: 480, y: 160 },
};

const statusColors: Record<TaskStatus, string> = {
  pending: "#87867f",
  running: "#d97757",
  completed: "#4ade80",
  failed: "#ef4444",
  killed: "#f59e0b",
};

const communicationPatterns: Record<
  CommunicationPattern,
  { title: string; description: string; details: string[] }
> = {
  foreground: {
    title: "전경(동기화)",
    description:
      "상위는 runAgent() 생성기를 직접 반복합니다. 메시지는 호출 스택을 생성합니다.",
    details: [
      "부모는 runAgent()를 호출하고 비동기 생성기를 반복합니다.",
      "각 메시지는 즉시 상위 메시지로 반환됩니다.",
      "부모의 중단 컨트롤러를 공유합니다(ESC는 둘 다 종료합니다).",
      "Promise.race를 통해 실행 도중 백그라운드로 전환할 수 있습니다.",
      "디스크 출력이 필요하지 않습니다. 메시지는 생성기 체인을 통해 흐릅니다.",
    ],
  },
  background: {
    title: "배경(비동기)",
    description:
      "세 가지 채널: 디스크 출력 파일, 작업 알림 및 보류 중인 메시지 대기열.",
    details: [
      "디스크: 모든 작업은 outputFile(JSONL 기록)에 기록됩니다.",
      "알림: XML <task-notification>이 부모 대화에 삽입되었습니다.",
      "대기열: SendMessage는 보류 중인 메시지 배열을 통해 실행 중인 에이전트를 대상으로 합니다.",
      "도구 라운드 경계(실행 중간이 아님)에서 메시지가 유출됩니다.",
      "통지된 플래그는 중복된 완료 메시지를 방지합니다.",
    ],
  },
  coordinator: {
    title: "코디네이터 모드",
    description:
      "관리자-근로자 계층 구조. 코디네이터는 Agent, SendMessage, TaskStop의 3가지 도구만 갖습니다.",
    details: [
      "코디네이터는 생각하고, 계획하고, 분해합니다. 코드를 직접 건드리지 않습니다.",
      "작업자는 조정 도구를 제외한 전체 도구 세트를 얻습니다.",
      "4단계: 연구 -> 합성 -> 구현 -> 검증",
      "\"이해를 위임하지 마십시오\" -- 코디네이터가 연구를 종합합니다.",
      "Scratchpad를 사용하면 파일 시스템을 통해 작업자 간 지식 공유가 가능합니다.",
    ],
  },
};

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

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "killed"
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function TaskStateMachine({ className }: Props) {
  const isDark = useDarkMode();
  const [currentStatus, setCurrentStatus] = useState<TaskStatus>("pending");
  const [activeTransition, setActiveTransition] = useState<Transition | null>(
    null
  );
  const [selectedPattern, setSelectedPattern] =
    useState<CommunicationPattern>("foreground");
  const animatingRef = useRef(false);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.08)",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    connectorLine: isDark ? "#444" : "#c2c0b6",
  };

  const performTransition = useCallback(
    (transition: Transition) => {
      if (animatingRef.current) return;
      if (transition.from !== currentStatus) return;

      animatingRef.current = true;
      setActiveTransition(transition);

      setTimeout(() => {
        setCurrentStatus(transition.to);
        setTimeout(() => {
          setActiveTransition(null);
          animatingRef.current = false;
        }, 300);
      }, 600);
    },
    [currentStatus]
  );

  const reset = useCallback(() => {
    setCurrentStatus("pending");
    setActiveTransition(null);
    animatingRef.current = false;
  }, []);

  const availableTransitions = transitions.filter(
    (t) => t.from === currentStatus
  );

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* State Machine Diagram */}
      <div
        style={{
          padding: "20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 20,
        }}
      >
        {/* SVG State Diagram */}
        <svg
          viewBox="0 0 580 210"
          style={{ width: "100%", height: "auto", display: "block" }}
        >
          {/* Transition arrows */}
          {transitions.map((t) => {
            const from = statusPositions[t.from];
            const to = statusPositions[t.to];
            const isActive = activeTransition === t;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const offsetX = (dx / len) * 50;
            const offsetY = (dy / len) * 50;

            return (
              <g key={`${t.from}-${t.to}`}>
                <defs>
                  <marker
                    id={`arrow-${t.from}-${t.to}`}
                    markerWidth="8"
                    markerHeight="8"
                    refX="8"
                    refY="4"
                    orient="auto"
                  >
                    <path
                      d="M0,0 L8,4 L0,8"
                      fill={isActive ? colors.terracotta : colors.connectorLine}
                    />
                  </marker>
                </defs>
                <line
                  x1={from.x + offsetX}
                  y1={from.y + offsetY}
                  x2={to.x - offsetX}
                  y2={to.y - offsetY}
                  stroke={isActive ? colors.terracotta : colors.connectorLine}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  markerEnd={`url(#arrow-${t.from}-${t.to})`}
                  style={{ transition: "stroke 0.3s, stroke-width 0.3s" }}
                />
                <text
                  x={midX}
                  y={midY - 10}
                  textAnchor="middle"
                  fill={isActive ? colors.terracotta : colors.textSecondary}
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.3s" }}
                >
                  {t.label}
                </text>
              </g>
            );
          })}

          {/* State nodes */}
          {(Object.keys(statusPositions) as TaskStatus[]).map((status) => {
            const pos = statusPositions[status];
            const isCurrent = currentStatus === status;
            const isTarget = activeTransition?.to === status;
            const nodeColor = statusColors[status];
            const isTerminal = isTerminalStatus(status);

            return (
              <g key={status}>
                {/* Glow for current */}
                {isCurrent && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={38}
                    fill="none"
                    stroke={nodeColor}
                    strokeWidth="2"
                    opacity="0.3"
                  >
                    <animate
                      attributeName="r"
                      values="38;44;38"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.3;0.1;0.3"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}

                {/* Node circle */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={32}
                  fill={
                    isCurrent
                      ? isDark
                        ? `${nodeColor}20`
                        : `${nodeColor}15`
                      : colors.cardBg
                  }
                  stroke={isCurrent || isTarget ? nodeColor : colors.cardBorder}
                  strokeWidth={isCurrent ? 2.5 : 1.5}
                  style={{ transition: "all 0.4s" }}
                />

                {/* Terminal state double circle */}
                {isTerminal && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={27}
                    fill="none"
                    stroke={
                      isCurrent || isTarget ? nodeColor : colors.cardBorder
                    }
                    strokeWidth={1}
                    opacity={0.5}
                    style={{ transition: "all 0.4s" }}
                  />
                )}

                <text
                  x={pos.x}
                  y={pos.y + 4}
                  textAnchor="middle"
                  fill={isCurrent ? nodeColor : colors.text}
                  fontSize="11"
                  fontWeight={isCurrent ? "700" : "500"}
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.3s" }}
                >
                  {status}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Controls + Transition Info */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 20,
        }}
      >
        {/* Transition buttons */}
        <div
          style={{
            padding: "16px 20px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            사용 가능한 전환
          </div>

          {availableTransitions.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {availableTransitions.map((t) => (
                <button
                  key={`${t.from}-${t.to}`}
                  onClick={() => performTransition(t)}
                  disabled={animatingRef.current}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: `1px solid ${statusColors[t.to]}40`,
                    background: `${statusColors[t.to]}10`,
                    color: statusColors[t.to],
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.2s",
                  }}
                >
                  {t.label}
                  <span
                    style={{
                      float: "right",
                      opacity: 0.6,
                      fontSize: 11,
                    }}
                  >
                    {t.from} -&amp;amp;gt; {t.to}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: colors.textSecondary }}>
              최종 상태에 도달했습니다.
              <button
                onClick={reset}
                style={{
                  display: "block",
                  marginTop: 10,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: colors.terracotta,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                }}
              >
                보류 중으로 재설정
              </button>
            </div>
          )}
        </div>

        {/* Transition detail */}
        <div
          style={{
            padding: "16px 20px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            전환 세부정보
          </div>

          <AnimatePresence mode="wait">
            {activeTransition ? (
              <motion.div
                key={`${activeTransition.from}-${activeTransition.to}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    color: colors.terracotta,
                    marginBottom: 8,
                  }}
                >
                  {activeTransition.from} -&amp;amp;gt; {activeTransition.to}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: colors.text,
                    marginBottom: 4,
                  }}
                >
                  트리거:
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginBottom: 10,
                  }}
                >
                  {activeTransition.trigger}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textSecondary,
                    lineHeight: 1.6,
                  }}
                >
                  {activeTransition.detail}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div style={{ fontSize: 13, color: colors.textSecondary }}>
                  세부 정보를 확인하고 상태 변경에 애니메이션을 적용하려면 전환을 클릭하세요.
                </div>
                <div
                  style={{
                    marginTop: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: colors.surfaceBg,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: colors.textSecondary,
                  }}
                >
                  isTerminalTaskStatus({currentStatus}) ={" "}
                  <span
                    style={{
                      color: isTerminalStatus(currentStatus)
                        ? statusColors.completed
                        : colors.terracotta,
                      fontWeight: 600,
                    }}
                  >
                    {String(isTerminalStatus(currentStatus))}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Communication Patterns */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            marginBottom: 14,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          의사소통 패턴
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 16,
            padding: 3,
            background: colors.surfaceBg,
            borderRadius: 8,
            border: `1px solid ${colors.cardBorder}`,
          }}
        >
          {(Object.keys(communicationPatterns) as CommunicationPattern[]).map(
            (pattern) => {
              const isActive = selectedPattern === pattern;
              return (
                <button
                  key={pattern}
                  onClick={() => setSelectedPattern(pattern)}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "none",
                    background: isActive ? colors.cardBg : "transparent",
                    color: isActive ? colors.terracotta : colors.textSecondary,
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 400,
                    fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    boxShadow: isActive
                      ? isDark
                        ? "0 1px 3px rgba(0,0,0,0.3)"
                        : "0 1px 3px rgba(0,0,0,0.1)"
                      : "none",
                  }}
                >
                  {communicationPatterns[pattern].title}
                </button>
              );
            }
          )}
        </div>

        {/* Pattern content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedPattern}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 8,
              }}
            >
              {communicationPatterns[selectedPattern].description}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {communicationPatterns[selectedPattern].details.map(
                (detail, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: colors.surfaceBg,
                      border: `1px solid ${colors.cardBorder}`,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 700,
                        color: colors.terracotta,
                        minWidth: 18,
                        marginTop: 1,
                      }}
                    >
                      {i + 1}.
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: colors.text,
                        lineHeight: 1.5,
                      }}
                    >
                      {detail}
                    </span>
                  </div>
                )
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
