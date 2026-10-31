import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type AgentType =
  | "general-purpose"
  | "explore"
  | "plan"
  | "verification"
  | "guide";

type AgentStatus = "running" | "completed";
type SpawnMode = "sync" | "async";

interface AgentNode {
  id: string;
  type: AgentType;
  status: AgentStatus;
  mode: SpawnMode;
  model: string;
  toolCount: number;
  permissionMode: string;
  description: string;
}

// --- Data ---

const agentTypeInfo: Record<
  AgentType,
  {
    model: string;
    toolCount: number;
    permissionMode: string;
    description: string;
    tools: string;
    defaultMode: SpawnMode;
  }
> = {
  "general-purpose": {
    model: "Sonnet",
    toolCount: 14,
    permissionMode: "default",
    description: "모든 도구를 갖춘 완전한 기능의 에이전트",
    tools: "Read, Write, Edit, Bash, Grep, Glob, Agent, ...",
    defaultMode: "sync",
  },
  explore: {
    model: "Haiku",
    toolCount: 5,
    permissionMode: "auto-deny writes",
    description: "읽기 전용 검색 전문가입니다. 가장 저렴하고 가장 빠릅니다.",
    tools: "Read, Grep, Glob, Bash (read-only), Agent",
    defaultMode: "sync",
  },
  plan: {
    model: "Haiku",
    toolCount: 5,
    permissionMode: "auto-deny writes",
    description: "연구 + 분석. 편집 기능 없음",
    tools: "Read, Grep, Glob, Bash (read-only), Agent",
    defaultMode: "sync",
  },
  verification: {
    model: "Opus",
    toolCount: 8,
    permissionMode: "default",
    description: "적대적 테스트 + 검증",
    tools: "Read, Bash, Grep, Glob, Edit, Write, ...",
    defaultMode: "async",
  },
  guide: {
    model: "Sonnet",
    toolCount: 3,
    permissionMode: "auto-deny writes",
    description: "사용자 지향 지침. 제한된 도구",
    tools: "Read, Grep, Glob",
    defaultMode: "sync",
  },
};

const agentTypeLabels: Record<AgentType, string> = {
  "general-purpose": "General-Purpose",
  explore: "Explore",
  plan: "Plan",
  verification: "Verification",
  guide: "Guide",
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

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `agent-${idCounter.toString(16).padStart(4, "0")}`;
}

// --- Component ---

interface Props {
  className?: string;
}

export default function SubAgentTree({ className }: Props) {
  const isDark = useDarkMode();
  const [agents, setAgents] = useState<AgentNode[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.08)",
    syncColor: "#4ade80",
    syncBg: isDark ? "rgba(74, 222, 128, 0.12)" : "rgba(74, 222, 128, 0.1)",
    asyncColor: "#60a5fa",
    asyncBg: isDark ? "rgba(96, 165, 250, 0.12)" : "rgba(96, 165, 250, 0.1)",
    completedBg: isDark ? "rgba(135,134,127,0.12)" : "rgba(135,134,127,0.08)",
    connectorLine: isDark ? "#444" : "#c2c0b6",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
  };

  const spawnAgent = useCallback(
    (type: AgentType) => {
      if (agents.length >= 6) return;
      const info = agentTypeInfo[type];
      const newAgent: AgentNode = {
        id: nextId(),
        type,
        status: "running",
        mode: info.defaultMode,
        model: info.model,
        toolCount: info.toolCount,
        permissionMode: info.permissionMode,
        description: info.description,
      };
      setAgents((prev) => [...prev, newAgent]);
      setSelectedAgent(newAgent.id);
      setDropdownOpen(false);

      // Auto-complete after a random delay
      const delay = 2000 + Math.random() * 3000;
      setTimeout(() => {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === newAgent.id ? { ...a, status: "completed" } : a
          )
        );
      }, delay);
    },
    [agents.length]
  );

  const clearAll = useCallback(() => {
    setAgents([]);
    setSelectedAgent(null);
  }, []);

  const selected = agents.find((a) => a.id === selectedAgent);
  const selectedInfo = selected ? agentTypeInfo[selected.type] : null;

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
        }}
      >
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            disabled={agents.length >= 6}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background:
                agents.length >= 6 ? colors.textSecondary : colors.terracotta,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: agents.length >= 6 ? "not-allowed" : "pointer",
              transition: "background 0.2s",
            }}
          >
            에이전트 생성 {agents.length >= 6 ? "(최대 6개)" : ""}
          </button>

          <AnimatePresence>
            {dropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 20,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: 10,
                  padding: 4,
                  minWidth: 200,
                  boxShadow: isDark
                    ? "0 8px 24px rgba(0,0,0,0.4)"
                    : "0 8px 24px rgba(0,0,0,0.12)",
                }}
              >
                {(Object.keys(agentTypeInfo) as AgentType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => spawnAgent(type)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "8px 12px",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      color: colors.text,
                      fontSize: 13,
                      fontFamily: "var(--font-mono)",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = colors.terracottaBg)
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <div style={{ fontWeight: 600 }}>
                      {agentTypeLabels[type]}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: colors.textSecondary,
                        marginTop: 2,
                      }}
                    >
                      {agentTypeInfo[type].model} / {agentTypeInfo[type].toolCount} 도구
                    </div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div style={{ flex: 1, minWidth: 20 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colors.syncColor,
              }}
            />
            동기화
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colors.asyncColor,
              }}
            />
            비동기
          </span>
        </div>

        {agents.length > 0 && (
          <button
            onClick={clearAll}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: `1px solid ${colors.cardBorder}`,
              background: "transparent",
              color: colors.textSecondary,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            지우기
          </button>
        )}
      </div>

      {/* Tree visualization */}
      <div ref={containerRef} style={{ position: "relative", minHeight: 200 }}>
        {/* Parent Agent node */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 40,
          }}
        >
          <div
            style={{
              padding: "14px 28px",
              borderRadius: 12,
              background: colors.terracottaBg,
              border: `2px solid ${colors.terracotta}`,
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 700,
              color: colors.terracotta,
              textAlign: "center",
            }}
          >
            상위 에이전트
            <div
              style={{
                fontSize: 11,
                fontWeight: 400,
                color: colors.textSecondary,
                marginTop: 4,
              }}
            >
              Opus / 14개 도구 / 메인 루프
            </div>
          </div>
        </div>

        {/* Connector lines + Children */}
        {agents.length > 0 && (
          <div style={{ position: "relative" }}>
            {/* Horizontal bus line */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left:
                  agents.length === 1
                    ? "50%"
                    : `${100 / (agents.length * 2)}%`,
                right:
                  agents.length === 1
                    ? "50%"
                    : `${100 / (agents.length * 2)}%`,
                height: 2,
                background: colors.connectorLine,
              }}
            />

            {/* Vertical line from parent to bus */}
            <div
              style={{
                position: "absolute",
                top: -40,
                left: "50%",
                transform: "translateX(-50%)",
                width: 2,
                height: 40,
                background: colors.connectorLine,
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${Math.min(agents.length, 3)}, 1fr)`,
                gap: 12,
                paddingTop: 2,
              }}
            >
              <AnimatePresence>
                {agents.map((agent) => {
                  const isActive = agent.status === "running";
                  const isSelected = selectedAgent === agent.id;
                  const modeColor =
                    agent.mode === "sync"
                      ? colors.syncColor
                      : colors.asyncColor;
                  const modeBg =
                    agent.mode === "sync" ? colors.syncBg : colors.asyncBg;

                  return (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, y: -20, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{
                        type: "spring",
                        stiffness: 300,
                        damping: 25,
                      }}
                      style={{ position: "relative", paddingTop: 20 }}
                    >
                      {/* Vertical connector from bus to node */}
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: "50%",
                          transform: "translateX(-50%)",
                          width: 2,
                          height: 20,
                          background: colors.connectorLine,
                        }}
                      />

                      <div
                        onClick={() =>
                          setSelectedAgent(
                            isSelected ? null : agent.id
                          )
                        }
                        style={{
                          padding: "12px 14px",
                          borderRadius: 10,
                          border: `1.5px solid ${
                            isSelected
                              ? colors.terracotta
                              : isActive
                                ? modeColor
                                : colors.cardBorder
                          }`,
                          background: isActive
                            ? modeBg
                            : colors.completedBg,
                          cursor: "pointer",
                          transition:
                            "border-color 0.2s, background 0.2s",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        {/* Pulsing indicator for running */}
                        {isActive && (
                          <motion.div
                            style={{
                              position: "absolute",
                              top: 8,
                              right: 8,
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: modeColor,
                            }}
                            animate={{
                              opacity: [1, 0.3, 1],
                            }}
                            transition={{
                              duration: 1.2,
                              repeat: Infinity,
                            }}
                          />
                        )}

                        {!isActive && (
                          <div
                            style={{
                              position: "absolute",
                              top: 8,
                              right: 8,
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: colors.textSecondary,
                              opacity: 0.5,
                            }}
                          />
                        )}

                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            fontFamily: "var(--font-mono)",
                            color: colors.text,
                            marginBottom: 6,
                          }}
                        >
                          {agentTypeLabels[agent.type]}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              padding: "2px 6px",
                              borderRadius: 4,
                              background: isDark
                                ? "rgba(135,134,127,0.15)"
                                : "rgba(135,134,127,0.1)",
                              color: colors.textSecondary,
                            }}
                          >
                            {agent.model}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              padding: "2px 6px",
                              borderRadius: 4,
                              background: isDark
                                ? "rgba(135,134,127,0.15)"
                                : "rgba(135,134,127,0.1)",
                              color: colors.textSecondary,
                            }}
                          >
                            {agent.toolCount} 도구
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              padding: "2px 6px",
                              borderRadius: 4,
                              background:
                                agent.mode === "sync"
                                  ? colors.syncBg
                                  : colors.asyncBg,
                              color: modeColor,
                              fontWeight: 600,
                            }}
                          >
                            {agent.mode}
                          </span>
                        </div>

                        <div
                          style={{
                            fontSize: 11,
                            color: isActive
                              ? colors.text
                              : colors.textSecondary,
                            marginTop: 6,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {isActive ? "실행중..." : "완료됨"}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* Empty state */}
        {agents.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              color: colors.textSecondary,
              fontSize: 14,
            }}
          >
            &quot;에이전트 생성&quot;을 클릭하여 하위 에이전트를 생성하고 이들이 어떻게 연결되는지 확인하세요.
            부모
          </div>
        )}
      </div>

      {/* Detail panel */}
      <AnimatePresence>
        {selected && selectedInfo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            style={{ overflow: "hidden" }}
          >
            <div
              style={{
                marginTop: 20,
                padding: "18px 22px",
                borderRadius: 12,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.cardBg,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                    color: colors.terracotta,
                  }}
                >
                  {agentTypeLabels[selected.type]} 대리인
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "3px 10px",
                    borderRadius: 6,
                    background:
                      selected.status === "running"
                        ? selected.mode === "sync"
                          ? colors.syncBg
                          : colors.asyncBg
                        : colors.completedBg,
                    color:
                      selected.status === "running"
                        ? selected.mode === "sync"
                          ? colors.syncColor
                          : colors.asyncColor
                        : colors.textSecondary,
                    fontWeight: 600,
                  }}
                >
                  {selected.status}
                </span>
              </div>

              <div style={{ fontSize: 13, color: colors.text, marginBottom: 14 }}>
                {selectedInfo.description}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                {[
                  { label: "모델", value: selected.model },
                  { label: "도구", value: `${selected.toolCount} available` },
                  { label: "권한 모드", value: selected.permissionMode },
                  {
                    label: "컨트롤러 중단",
                    value:
                      selected.mode === "sync"
                        ? "공유(ESC는 둘 다 종료)"
                        : "독립(ESC에서 살아남음)",
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: colors.surfaceBg,
                      border: `1px solid ${colors.cardBorder}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: colors.textSecondary,
                        marginBottom: 3,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      {item.label}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontFamily: "var(--font-mono)",
                        color: colors.text,
                        fontWeight: 500,
                      }}
                    >
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  marginTop: 12,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: colors.surfaceBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: colors.textSecondary,
                    marginBottom: 3,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  사용 가능한 도구
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: colors.text,
                  }}
                >
                  {selectedInfo.tools}
                </div>
              </div>

              {/* Sync vs Async explanation */}
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 14px",
                  borderRadius: 8,
                  background:
                    selected.mode === "sync"
                      ? colors.syncBg
                      : colors.asyncBg,
                  border: `1px solid ${
                    selected.mode === "sync"
                      ? "rgba(74, 222, 128, 0.3)"
                      : "rgba(96, 165, 250, 0.3)"
                  }`,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color:
                      selected.mode === "sync"
                        ? colors.syncColor
                        : colors.asyncColor,
                    marginBottom: 4,
                  }}
                >
                  {selected.mode === "sync"
                    ? "동기 실행"
                    : "비동기 실행"}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textSecondary,
                    lineHeight: 1.5,
                  }}
                >
                  {selected.mode === "sync"
                    ? "상위 에이전트를 차단합니다. 중단 컨트롤러를 공유합니다(ESC는 둘 다 종료합니다). 상위는 runAgent() 생성기를 직접 반복하여 호출 스택에 메시지를 생성합니다."
                    : "백그라운드에서 독립적으로 실행됩니다. 자체 중단 컨트롤러를 가져옵니다(ESC가 유지됨). 결과가 디스크 출력 파일에 기록됩니다. 작업 알림을 통해 부모에게 완료 알림이 전달됩니다."}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
