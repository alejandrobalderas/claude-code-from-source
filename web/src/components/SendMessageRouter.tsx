import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type RouteType =
  | "bridge"
  | "uds"
  | "registry_running"
  | "registry_terminal"
  | "mailbox"
  | "error";

interface RouteStep {
  id: string;
  label: string;
  check: string;
  detail: string;
}

interface Preset {
  name: string;
  description: string;
  resolvedRoute: RouteType;
  rawTo: string;
}

interface RoutingResult {
  route: RouteType;
  label: string;
  detail: string;
  color: string;
}

// --- Data ---

const routeSteps: RouteStep[] = [
  {
    id: "bridge",
    label: "교량 운송",
    check: "\"브리지:\"로 시작하나요?",
    detail:
      "원격 제어 릴레이를 통한 기계 간 통신. 서로 다른 시스템에 있는 두 개의 Claude Code 인스턴스는 Anthropic의 서버를 통해 통신합니다. 명시적인 사용자 동의가 필요합니다.",
  },
  {
    id: "uds",
    label: "UDS 소켓",
    check: "\"uds:\"로 시작하나요?",
    detail:
      "Unix 도메인 소켓을 통한 로컬 프로세스 간. 서로 다른 프로세스(예: VS Code 확장 + 터미널)의 동일한 머신에 있는 인스턴스의 경우. 빠르고 안전하며 안정적입니다.",
  },
  {
    id: "registry_running",
    label: "진행 중(실행 중)",
    check: "AgentNameRegistry에서 발견되어 실행 중입니까?",
    detail:
      "가장 일반적인 경로. PendingMessages 배열을 통해 대기 중인 메시지는 다음 도구 라운드 경계에서 전달됩니다. 회전 구조를 유지하며 경쟁 조건이 없습니다.",
  },
  {
    id: "registry_terminal",
    label: "죽은 에이전트 재개",
    check: "찾았지만 종료 상태인가요?",
    detail:
      "자동 재개: 디스크 기록에서 에이전트를 재구성하고, 메시지 기록을 재구성하고, 백그라운드 작업으로 다시 등록합니다. 코디네이터는 에이전트의 활성 상태를 추적할 필요가 없습니다.",
  },
  {
    id: "mailbox",
    label: "팀 사서함",
    check: "팀 컨텍스트가 활성화되어 있나요?",
    detail:
      "파일 기반 메일함 시스템. 디스크에 있는 수신자의 메일함 파일에 기록된 메시지입니다. \"*\" 와일드카드를 통한 브로드캐스트를 지원합니다. 최대: UI 표현을 위한 메시지 50개",
  },
  {
    id: "error",
    label: "오류",
    check: "실패",
    detail: "라우팅 테이블에서 수신자를 찾을 수 없습니다. 보낸 사람에게 오류를 반환합니다.",
  },
];

const routeResults: Record<RouteType, RoutingResult> = {
  bridge: {
    route: "bridge",
    label: "브리지 릴레이",
    detail: "원격 제어 서버를 통해 전달됨(기계 간)",
    color: "#6b8dd6",
  },
  uds: {
    route: "uds",
    label: "UDS 소켓",
    detail: "Unix 도메인 소켓을 통해 전달됨(로컬 프로세스 간)",
    color: "#6b8dd6",
  },
  registry_running: {
    route: "registry_running",
    label: "대기 중",
    detail: "보류 중인 메시지에 대기 중이며 도구 라운드 경계에서 전달됨",
    color: "#4ade80",
  },
  registry_terminal: {
    route: "registry_terminal",
    label: "재개됨",
    detail: "전체 기록이 포함된 디스크 기록에서 에이전트가 부활했습니다.",
    color: "#f59e0b",
  },
  mailbox: {
    route: "mailbox",
    label: "사서함",
    detail: "비동기 전달을 위해 파일 기반 사서함에 기록",
    color: "#4ade80",
  },
  error: {
    route: "error",
    label: "오류",
    detail: "라우팅 테이블에서 수신자를 찾을 수 없습니다.",
    color: "#ef4444",
  },
};

const presets: Preset[] = [
  {
    name: "bridge:remote-session-1",
    description: "머신 간 원격 세션",
    resolvedRoute: "bridge",
    rawTo: "bridge:remote-session-1",
  },
  {
    name: "uds:/tmp/claude.sock",
    description: "VS Code 확장 소켓",
    resolvedRoute: "uds",
    rawTo: "uds:/tmp/claude.sock",
  },
  {
    name: "researcher",
    description: "백그라운드 에이전트 실행 중",
    resolvedRoute: "registry_running",
    rawTo: "researcher",
  },
  {
    name: "explorer-agent",
    description: "완료된 에이전트(재개 예정)",
    resolvedRoute: "registry_terminal",
    rawTo: "explorer-agent",
  },
  {
    name: "background-worker",
    description: "우편함을 가지고 있는 에이전트 군집의 팀원",
    resolvedRoute: "mailbox",
    rawTo: "background-worker",
  },
  {
    name: "nonexistent-agent",
    description: "알 수 없는 수신자",
    resolvedRoute: "error",
    rawTo: "nonexistent-agent",
  },
];

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

function getRouteForInput(input: string): RouteType {
  const trimmed = input.trim();
  if (!trimmed) return "error";
  const preset = presets.find(
    (p) => p.rawTo.toLowerCase() === trimmed.toLowerCase()
  );
  if (preset) return preset.resolvedRoute;
  if (trimmed.startsWith("bridge:")) return "bridge";
  if (trimmed.startsWith("uds:")) return "uds";
  return "error";
}

function getStepIndex(route: RouteType): number {
  const map: Record<RouteType, number> = {
    bridge: 0,
    uds: 1,
    registry_running: 2,
    registry_terminal: 3,
    mailbox: 4,
    error: 5,
  };
  return map[route];
}

// --- Component ---

interface Props {
  className?: string;
}

export default function SendMessageRouter({ className }: Props) {
  const isDark = useDarkMode();
  const [recipientInput, setRecipientInput] = useState("");
  const [isRouting, setIsRouting] = useState(false);
  const [currentCheckIndex, setCurrentCheckIndex] = useState(-1);
  const [matchedRoute, setMatchedRoute] = useState<RouteType | null>(null);
  const [mailboxCount, setMailboxCount] = useState(0);
  const animatingRef = useRef(false);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.15)"
      : "rgba(217, 119, 87, 0.08)",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    inputBg: isDark ? "#2a2a28" : "#f5f4ed",
    connectorLine: isDark ? "#444" : "#c2c0b6",
    stepBg: isDark ? "#252523" : "#fafaf7",
    stepActiveBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.06)",
    stepPassedBg: isDark
      ? "rgba(135, 134, 127, 0.08)"
      : "rgba(135, 134, 127, 0.05)",
  };

  const routeMessage = useCallback(() => {
    if (animatingRef.current || !recipientInput.trim()) return;
    animatingRef.current = true;
    setIsRouting(true);
    setMatchedRoute(null);
    setCurrentCheckIndex(-1);

    const route = getRouteForInput(recipientInput);
    const targetIndex = getStepIndex(route);

    let step = 0;
    const interval = setInterval(() => {
      setCurrentCheckIndex(step);
      if (step === targetIndex) {
        clearInterval(interval);
        setTimeout(() => {
          setMatchedRoute(route);
          if (route === "mailbox") {
            setMailboxCount((c) => Math.min(c + 1, 50));
          }
          setTimeout(() => {
            setIsRouting(false);
            animatingRef.current = false;
          }, 1200);
        }, 400);
      }
      step++;
    }, 350);
  }, [recipientInput]);

  const selectPreset = useCallback(
    (preset: Preset) => {
      if (animatingRef.current) return;
      setRecipientInput(preset.rawTo);
      setMatchedRoute(null);
      setCurrentCheckIndex(-1);
    },
    []
  );

  const reset = useCallback(() => {
    setRecipientInput("");
    setIsRouting(false);
    setCurrentCheckIndex(-1);
    setMatchedRoute(null);
    setMailboxCount(0);
    animatingRef.current = false;
  }, []);

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Header */}
      <div
        style={{
          padding: "20px 24px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: colors.terracotta,
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: colors.terracotta,
              fontWeight: 600,
            }}
          >
            SendMessage 라우팅 발송
          </span>
          <span
            style={{
              fontSize: 12,
              color: colors.textSecondary,
              marginLeft: "auto",
            }}
          >
            제 10 장 -- 조정
          </span>
        </div>

        {/* Input area */}
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: colors.textSecondary,
              }}
            >
              에:
            </span>
            <input
              type="text"
              value={recipientInput}
              onChange={(e) => {
                setRecipientInput(e.target.value);
                setMatchedRoute(null);
                setCurrentCheckIndex(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") routeMessage();
              }}
              placeholder="받는 사람 이름이나 주소..."
              style={{
                width: "100%",
                padding: "10px 12px 10px 36px",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                background: colors.inputBg,
                color: colors.text,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: 8,
                outline: "none",
              }}
            />
          </div>
          <button
            onClick={routeMessage}
            disabled={isRouting || !recipientInput.trim()}
            style={{
              padding: "10px 20px",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontWeight: 600,
              background: isRouting ? colors.textSecondary : colors.terracotta,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor:
                isRouting || !recipientInput.trim()
                  ? "not-allowed"
                  : "pointer",
              opacity: isRouting || !recipientInput.trim() ? 0.5 : 1,
              transition: "opacity 0.2s, background 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {isRouting ? "라우팅..." : "메시지 라우팅"}
          </button>
          {(matchedRoute || currentCheckIndex >= 0) && (
            <button
              onClick={reset}
              style={{
                padding: "10px 14px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                background: "transparent",
                color: colors.textSecondary,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              재설정
            </button>
          )}
        </div>

        {/* Presets */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {presets.map((preset) => (
            <button
              key={preset.rawTo}
              onClick={() => selectPreset(preset)}
              style={{
                padding: "5px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                background:
                  recipientInput === preset.rawTo
                    ? colors.terracottaBg
                    : colors.stepBg,
                color:
                  recipientInput === preset.rawTo
                    ? colors.terracotta
                    : colors.textSecondary,
                border: `1px solid ${
                  recipientInput === preset.rawTo
                    ? colors.terracotta
                    : colors.cardBorder
                }`,
                borderRadius: 6,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {/* Routing Pipeline */}
      <div
        style={{
          padding: "20px 24px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            marginBottom: 14,
            fontFamily: "var(--font-mono)",
          }}
        >
          우선순위 파견 체인
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {routeSteps.map((step, index) => {
            const isChecking = currentCheckIndex === index && !matchedRoute;
            const isPassed =
              currentCheckIndex > index ||
              (matchedRoute !== null && getStepIndex(matchedRoute) > index);
            const isMatched =
              matchedRoute !== null &&
              getStepIndex(matchedRoute) === index;
            const isNotReached =
              currentCheckIndex < index && !matchedRoute;

            let stepBg = colors.stepBg;
            let borderColor = colors.cardBorder;
            let indicatorColor = colors.textSecondary;

            if (isChecking) {
              stepBg = colors.stepActiveBg;
              borderColor = colors.terracotta;
              indicatorColor = colors.terracotta;
            } else if (isMatched) {
              stepBg = isDark
                ? "RGBA(217, 119, 87, 0.18)"
                : "RGBA(217, 119, 87, 0.1)";
              borderColor = colors.terracotta;
              indicatorColor = colors.terracotta;
            } else if (isPassed) {
              stepBg = colors.stepPassedBg;
              indicatorColor = colors.textSecondary;
            }

            return (
              <div key={step.id}>
                {/* Connector line */}
                {index > 0 && (
                  <div
                    style={{
                      width: 2,
                      height: 8,
                      marginLeft: 19,
                      background:
                        isPassed || isChecking || isMatched
                          ? colors.terracotta
                          : colors.connectorLine,
                      transition: "background 0.3s",
                    }}
                  />
                )}

                <motion.div
                  animate={{
                    backgroundColor: stepBg,
                    borderColor: borderColor,
                  }}
                  transition={{ duration: 0.3 }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "12px 16px",
                    borderRadius: 8,
                    border: `1px solid ${borderColor}`,
                    background: stepBg,
                    opacity: isNotReached && currentCheckIndex >= 0 ? 0.4 : 1,
                    transition: "opacity 0.3s",
                  }}
                >
                  {/* Step number indicator */}
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                      background: isMatched
                        ? colors.terracotta
                        : isChecking
                        ? colors.terracottaBg
                        : "transparent",
                      color: isMatched
                        ? "#fff"
                        : indicatorColor,
                      border: `1.5px solid ${indicatorColor}`,
                      transition: "all 0.3s",
                    }}
                  >
                    {isMatched ? (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path
                          d="M2 6l3 3 5-5"
                          stroke="#fff"
                          strokeWidth="2"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : isPassed ? (
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <line
                          x1="2"
                          y1="5"
                          x2="8"
                          y2="5"
                          stroke={colors.textSecondary}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 2,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 13,
                          fontWeight: 600,
                          color: isMatched
                            ? colors.terracotta
                            : isChecking
                            ? colors.terracotta
                            : colors.text,
                          transition: "color 0.3s",
                        }}
                      >
                        {step.label}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          color: colors.textSecondary,
                        }}
                      >
                        {step.check}
                      </span>
                    </div>

                    <AnimatePresence>
                      {(isChecking || isMatched) && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                          style={{
                            fontSize: 12,
                            color: colors.textSecondary,
                            lineHeight: 1.5,
                            overflow: "hidden",
                          }}
                        >
                          {step.detail}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Checking spinner */}
                  {isChecking && (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{
                        duration: 1,
                        repeat: Infinity,
                        ease: "linear",
                      }}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        border: `2px solid ${colors.cardBorder}`,
                        borderTopColor: colors.terracotta,
                        flexShrink: 0,
                      }}
                    />
                  )}

                  {/* Matched badge */}
                  <AnimatePresence>
                    {isMatched && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        style={{
                          padding: "4px 10px",
                          background: colors.terracotta,
                          color: "#fff",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          fontWeight: 600,
                          borderRadius: 6,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        배달되었습니다!
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Result + Mailbox Counter */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Result card */}
        <AnimatePresence>
          {matchedRoute && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              style={{
                flex: "1 1 300px",
                padding: "16px 20px",
                background: colors.cardBg,
                border: `1px solid ${routeResults[matchedRoute].color}`,
                borderRadius: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: routeResults[matchedRoute].color,
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    fontWeight: 600,
                    color: routeResults[matchedRoute].color,
                  }}
                >
                  {routeResults[matchedRoute].label}
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: colors.textSecondary,
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {routeResults[matchedRoute].detail}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mailbox counter */}
        <div
          style={{
            flex: "0 0 auto",
            minWidth: 180,
            padding: "16px 20px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: colors.textSecondary,
              marginBottom: 6,
            }}
          >
            사서함 메시지
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 4,
            }}
          >
            <motion.span
              key={mailboxCount}
              initial={{ scale: 1.3, color: colors.terracotta }}
              animate={{ scale: 1, color: colors.text }}
              transition={{ duration: 0.3 }}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 28,
                fontWeight: 700,
                color: colors.text,
              }}
            >
              {mailboxCount}
            </motion.span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: colors.textSecondary,
              }}
            >
              / 50
            </span>
          </div>
          {/* Mini progress bar */}
          <div
            style={{
              width: "100%",
              height: 4,
              background: colors.stepBg,
              borderRadius: 2,
              marginTop: 8,
              overflow: "hidden",
            }}
          >
            <motion.div
              animate={{ width: `${(mailboxCount / 50) * 100}%` }}
              transition={{ duration: 0.3 }}
              style={{
                height: "100%",
                background:
                  mailboxCount >= 45
                    ? "#ef4444"
                    : mailboxCount >= 30
                    ? "#f59e0b"
                    : colors.terracotta,
                borderRadius: 2,
              }}
            />
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: colors.textSecondary,
              marginTop: 4,
            }}
          >
            UI 메시지 캡
          </div>
        </div>
      </div>
    </div>
  );
}
