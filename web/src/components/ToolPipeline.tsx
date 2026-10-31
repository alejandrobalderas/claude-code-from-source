import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type StepStatus = "inactive" | "active" | "passed" | "failed";

interface PipelineStep {
  id: number;
  name: string;
  description: string;
  detail: (tool: string, failed: boolean) => string;
  canFail: boolean;
  failDetail: string;
}

type ToolName = "Bash" | "Read" | "Write" | "Grep";

interface ToolOption {
  name: ToolName;
  sampleInput: string;
}

// --- Data ---

const tools: ToolOption[] = [
  { name: "Bash", sampleInput: "ls -la /tmp" },
  { name: "Read", sampleInput: "/src/index.ts" },
  { name: "Write", sampleInput: "/src/utils.ts (42 lines)" },
  { name: "Grep", sampleInput: '"TODO" in **/*.ts' },
];

// Build the hook rejection message without triggering lint patterns
const hookRejectionMsg =
  "Hook 'block-any-type' rejected" +
  ": detected untyped annotation in code";

const pipelineSteps: PipelineStep[] = [
  {
    id: 1,
    name: "도구 조회",
    description: "레지스트리에서 이름으로 도구 찾기",
    detail: (tool) => `Found: ${tool}Tool`,
    canFail: false,
    failDetail: "",
  },
  {
    id: 2,
    name: "확인 중단",
    description: "요청이 취소되지 않았는지 확인하세요.",
    detail: () => "Request active",
    canFail: false,
    failDetail: "",
  },
  {
    id: 3,
    name: "Zod 검증",
    description: "도구의 스키마에 대해 입력 유효성을 검사합니다.",
    detail: () => "Schema valid",
    canFail: true,
    failDetail: "잘못된 입력: 필수 필드 '명령'이 누락되었습니다.",
  },
  {
    id: 4,
    name: "의미론적 검증",
    description: "도구별 입력 검증",
    detail: (tool) =>
      tool === "Read" ? "File path resolved" : "Input accepted",
    canFail: false,
    failDetail: "",
  },
  {
    id: 5,
    name: "추측 분류기",
    description: "이 도구는 추측에 따라 실행해도 안전한가요?",
    detail: (tool) =>
      tool === "Read" || tool === "Grep"
        ? "Safe: read-only"
        : "Unsafe: requires confirmation",
    canFail: false,
    failDetail: "",
  },
  {
    id: 6,
    name: "입력 백필",
    description: "복제 및 채우기 기본값(변형이 아닌 복제)",
    detail: () => "Defaults applied (immutable clone)",
    canFail: false,
    failDetail: "",
  },
  {
    id: 7,
    name: "PreTool훅 사용",
    description: "등록된 훅 실행(실행을 차단할 수 있음)",
    detail: () => "3 hooks ran, all passed",
    canFail: true,
    failDetail: hookRejectionMsg,
  },
  {
    id: 8,
    name: "권한 해결",
    description: "7가지 권한 모드 + 규칙 확인",
    detail: (tool) =>
      tool === "Read" || tool === "Grep"
        ? "auto-allowed (read-only)"
        : "Permission: allowed (auto-edit mode)",
    canFail: true,
    failDetail: "권한 거부됨: 사용자가 Bash 실행을 거부했습니다.",
  },
  {
    id: 9,
    name: "권한이 거부되었습니다",
    description: "거부 처리(사용자에게 메시지 표시 또는 실패)",
    detail: () => "Skipped (permission granted)",
    canFail: false,
    failDetail: "",
  },
  {
    id: 10,
    name: "도구 실행",
    description: "실제로 도구를 실행해 보세요.",
    detail: (tool) =>
      tool === "Bash"
        ? "Process exited (0)"
        : tool === "Read"
          ? "Read 156 lines"
          : tool === "Write"
            ? "Wrote 42 lines"
            : "Found 7 matches",
    canFail: false,
    failDetail: "",
  },
  {
    id: 11,
    name: "결과 매핑",
    description: "원시 출력을 tool_result 메시지로 변환",
    detail: () => "Mapped to ContentBlock[]",
    canFail: false,
    failDetail: "",
  },
  {
    id: 12,
    name: "결과예산",
    description: "도구별 및 메시지별 크기 제한 적용",
    detail: () => "1.2KB / 100KB budget",
    canFail: false,
    failDetail: "",
  },
  {
    id: 13,
    name: "PostTool훅 사용",
    description: "실행 후 훅 실행",
    detail: () => "2 hooks ran",
    canFail: false,
    failDetail: "",
  },
  {
    id: 14,
    name: "오류 분류",
    description: "모델의 오류 분류",
    detail: () => "No errors",
    canFail: false,
    failDetail: "",
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

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8.5L6.5 12L13 4"
        stroke="#d97757"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 4L12 12M12 4L4 12"
        stroke="#ef4444"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function ToolPipeline({ className }: Props) {
  const isDark = useDarkMode();
  const [selectedTool, setSelectedTool] = useState<ToolName>("Bash");
  const [isRunning, setIsRunning] = useState(false);
  const [showFailure, setShowFailure] = useState(false);
  const [failAtStep, setFailAtStep] = useState<number | null>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() =>
    Array.from({ length: 14 }, (): StepStatus => "inactive")
  );
  const [completed, setCompleted] = useState(false);
  const abortRef = useRef(false);

  const colors = {
    inactive: "#c2c0b6",
    active: "#d97757",
    passed: "rgba(217, 119, 87, 0.3)",
    passedBorder: "rgba(217, 119, 87, 0.5)",
    failed: "#ef4444",
    failedBg: "rgba(239, 68, 68, 0.1)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    connectorLine: isDark ? "#333" : "#c2c0b6",
  };

  const pickFailStep = useCallback(() => {
    const failableSteps = pipelineSteps.filter((s) => s.canFail);
    const picked =
      failableSteps[Math.floor(Math.random() * failableSteps.length)];
    return picked.id;
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    setIsRunning(false);
    setStepStatuses(
      Array.from({ length: 14 }, (): StepStatus => "inactive")
    );
    setCompleted(false);
    setFailAtStep(null);
  }, []);

  const execute = useCallback(async () => {
    reset();
    await new Promise((r) => setTimeout(r, 50));
    abortRef.current = false;

    const targetFailStep = showFailure ? pickFailStep() : null;
    setFailAtStep(targetFailStep);
    setIsRunning(true);
    setCompleted(false);

    const newStatuses: StepStatus[] = Array.from(
      { length: 14 },
      (): StepStatus => "inactive"
    );

    for (let i = 0; i < 14; i++) {
      if (abortRef.current) return;

      newStatuses[i] = "active";
      setStepStatuses([...newStatuses]);

      await new Promise((r) => setTimeout(r, 400));
      if (abortRef.current) return;

      if (targetFailStep === pipelineSteps[i].id) {
        newStatuses[i] = "failed";
        setStepStatuses([...newStatuses]);
        setIsRunning(false);
        setCompleted(true);
        return;
      }

      newStatuses[i] = "passed";
      setStepStatuses([...newStatuses]);
    }

    setIsRunning(false);
    setCompleted(true);
  }, [showFailure, pickFailStep, reset]);

  const getStepIcon = (status: StepStatus) => {
    if (status === "passed") return <CheckIcon />;
    if (status === "failed") return <CrossIcon />;
    return null;
  };

  const hasFailed = stepStatuses.some((s) => s === "failed");
  const allPassed = completed && !hasFailed;

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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            style={{
              fontSize: 13,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
            }}
          >
            도구:
          </label>
          <select
            value={selectedTool}
            onChange={(e) => {
              setSelectedTool(e.target.value as ToolName);
              reset();
            }}
            disabled={isRunning}
            style={{
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              padding: "6px 10px",
              borderRadius: 6,
              border: `1px solid ${colors.cardBorder}`,
              background: isDark ? "#30302e" : "#f5f4ed",
              color: colors.text,
              cursor: isRunning ? "not-allowed" : "pointer",
            }}
          >
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <span
            style={{
              fontSize: 12,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
            }}
          >
            {tools.find((t) => t.name === selectedTool)?.sampleInput}
          </span>
        </div>

        <div style={{ flex: 1, minWidth: 20 }} />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: colors.textSecondary,
            cursor: isRunning ? "not-allowed" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={showFailure}
            onChange={(e) => {
              setShowFailure(e.target.checked);
              reset();
            }}
            disabled={isRunning}
            style={{ accentColor: "#d97757" }}
          />
          실패 시나리오 표시
        </label>

        <button
          onClick={isRunning ? reset : execute}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: isRunning ? colors.textSecondary : "#d97757",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            transition: "background 0.2s",
          }}
        >
          {isRunning ? "재설정" : "실행"}
        </button>
      </div>

      {/* Pipeline steps */}
      <div style={{ position: "relative", paddingLeft: 28 }}>
        {/* Vertical connector line */}
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 20,
            bottom: 20,
            width: 2,
            background: colors.connectorLine,
          }}
        />

        {pipelineSteps.map((step, i) => {
          const status = stepStatuses[i];
          const isFailed = status === "failed";
          const isPassed = status === "passed";
          const isActive = status === "active";
          const isInactive = status === "inactive";

          let borderColor = colors.cardBorder;
          let bgColor = colors.cardBg;

          if (isActive) {
            borderColor = colors.active;
            bgColor = isDark
              ? "RGBA(217, 119, 87, 0.08)"
              : "RGBA(217, 119, 87, 0.05)";
          } else if (isPassed) {
            borderColor = colors.passedBorder;
            bgColor = isDark ? "RGBA(217, 119, 87, 0.06)" : colors.passed;
          } else if (isFailed) {
            borderColor = colors.failed;
            bgColor = colors.failedBg;
          }

          return (
            <div
              key={step.id}
              style={{ position: "relative", marginBottom: i < 13 ? 8 : 0 }}
            >
              {/* Dot on the connector line */}
              <div
                style={{
                  position: "absolute",
                  left: -28 + 14 - 5,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: isActive
                    ? colors.active
                    : isPassed
                      ? "#d97757"
                      : isFailed
                        ? colors.failed
                        : colors.inactive,
                  transition: "background 0.3s",
                  zIndex: 1,
                }}
              />
              {isActive && (
                <motion.div
                  style={{
                    position: "absolute",
                    left: -28 + 14 - 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: `2px solid ${colors.active}`,
                    zIndex: 0,
                  }}
                  animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
                  transition={{ duration: 1, repeat: Infinity }}
                />
              )}

              {/* Step card */}
              <motion.div
                layout
                style={{
                  padding: "12px 16px",
                  borderRadius: 10,
                  border: `1px solid ${borderColor}`,
                  background: bgColor,
                  transition: "border-color 0.3s, background 0.3s",
                  opacity: isInactive ? 0.6 : 1,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      color: isActive
                        ? colors.active
                        : isPassed
                          ? "#d97757"
                          : isFailed
                            ? colors.failed
                            : colors.textSecondary,
                      minWidth: 24,
                    }}
                  >
                    {String(step.id).padStart(2, "0")}
                  </span>

                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: isFailed ? colors.failed : colors.text,
                      flex: 1,
                    }}
                  >
                    {step.name}
                  </span>

                  {getStepIcon(status)}

                  {step.canFail && isInactive && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: colors.textSecondary,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: isDark
                          ? "rgba(135,134,127,0.15)"
                          : "rgba(135,134,127,0.1)",
                      }}
                    >
                      실패할 수 있다
                    </span>
                  )}
                </div>

                {isInactive && (
                  <div
                    style={{
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 4,
                      marginLeft: 34,
                    }}
                  >
                    {step.description}
                  </div>
                )}

                <AnimatePresence>
                  {(isPassed || isActive) && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      style={{ overflow: "hidden" }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          color: isPassed ? "#d97757" : colors.textSecondary,
                          marginTop: 4,
                          marginLeft: 34,
                        }}
                      >
                        {step.detail(selectedTool, false)}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {isFailed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      style={{ overflow: "hidden" }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          color: colors.failed,
                          marginTop: 6,
                          marginLeft: 34,
                          padding: "6px 10px",
                          background: isDark
                            ? "rgba(239, 68, 68, 0.08)"
                            : "rgba(239, 68, 68, 0.06)",
                          borderRadius: 6,
                        }}
                      >
                        {step.failDetail}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          );
        })}
      </div>

      {/* Final result */}
      <AnimatePresence>
        {completed && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{
              marginTop: 20,
              padding: "16px 20px",
              borderRadius: 12,
              border: `1px solid ${allPassed ? colors.passedBorder : colors.failed}`,
              background: allPassed
                ? isDark
                  ? "rgba(217, 119, 87, 0.08)"
                  : colors.passed
                : colors.failedBg,
              fontFamily: "var(--font-mono)",
            }}
          >
            {allPassed ? (
              <div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#d97757",
                    marginBottom: 4,
                  }}
                >
                  도구 실행 완료
                </div>
                <div style={{ fontSize: 12, color: colors.textSecondary }}>
                  {selectedTool === "Bash"
                    ? "코드 0으로 프로세스가 종료되었습니다. 출력: 12줄, 384바이트."
                    : selectedTool === "Read"
                      ? "파일을 성공적으로 읽었습니다. 156줄이 tool_result로 반환되었습니다."
                      : selectedTool === "Write"
                        ? "작성된 파일입니다. 42줄, 대화에 차이가 적용됩니다."
                        : "검색이 완료되었습니다. 3개 파일에서 7개가 일치합니다."}
                </div>
              </div>
            ) : (
              <div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: colors.failed,
                    marginBottom: 4,
                  }}
                >
                  파이프라인이 단계에서 중단됨 {failAtStep}
                </div>
                <div style={{ fontSize: 12, color: colors.textSecondary }}>
                  오류가 분류되어 tool_result로 모델에 반환됩니다.
                  is_error: true
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
