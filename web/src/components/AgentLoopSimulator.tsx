import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Step Data ---

interface Step {
  id: number;
  title: string;
  shortTitle: string;
  description: string;
  visual: React.ReactNode;
}

function StepVisual({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "rgba(217, 119, 87, 0.08)",
        borderRadius: 8,
        padding: "12px 16px",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

const steps: Step[] = [
  {
    id: 1,
    title: "입력 수신",
    shortTitle: "입력",
    description:
      "루프는 사용자가 메시지를 보내거나 이전 반복의 도구 결과가 도착할 때 시작됩니다. 이는 대화 기록에 추가되는 새 메시지가 됩니다.",
    visual: (
      <StepVisual>
        <div style={{ opacity: 0.5, marginBottom: 4 }}>// new messages</div>
        <div>
          {"{"} 역할: <span style={{ color: "#d97757" }}>&quot;사용자&quot;</span>, 내용:{" "}
          <span style={{ color: "#d97757" }}>&quot;구성 파일 읽기&quot;</span> {"}"}
        </div>
      </StepVisual>
    ),
  },
  {
    id: 2,
    title: "컨텍스트 관리",
    shortTitle: "맥락",
    description:
      "모델을 호출하기 전에 시스템은 토큰 사용량을 확인합니다. 대화가 너무 길면 압축 레이어가 시작됩니다: 도구 결과 예산 책정, 스닙 압축 또는 전체 요약.",
    visual: (
      <StepVisual>
        <div>
          사용된 토큰: <strong>142,800</strong> / 200,000
        </div>
        <div style={{ color: "#22c55e", marginTop: 4 }}>
          기준치 미만(80%). 압축이 필요하지 않습니다.
        </div>
      </StepVisual>
    ),
  },
  {
    id: 3,
    title: "모델로 스트리밍",
    shortTitle: "스트림",
    description:
      "전체 메시지 배열이 Claude API로 전송됩니다. 응답 토큰은 실시간으로 다시 스트리밍됩니다. 시스템은 각 청크가 도착하는 대로 처리하여 텍스트 및 tool_use 블록을 구축합니다.",
    visual: (
      <StepVisual>
        <div style={{ opacity: 0.5 }}>// streaming response...</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: "#87867f" }}>{">"}</span> 읽어 보도록 할게요
          당신을 위한 구성 파일
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 16,
              background: "#d97757",
              marginLeft: 2,
              verticalAlign: "middle",
              animation: "blink 1s step-end infinite",
            }}
          />
        </div>
        <style>{"@keyframes 깜박임 { 50% { 불투명도: 0; } }"}</style>
      </StepVisual>
    ),
  },
  {
    id: 4,
    title: "구문 분석 응답",
    shortTitle: "구문 분석",
    description:
      "스트리밍이 완료되면 응답이 콘텐츠 블록으로 구문 분석됩니다. 텍스트 블록은 가시적 출력이 됩니다. tool_use 블록은 이름, ID 및 입력 매개변수와 함께 추출됩니다.",
    visual: (
      <StepVisual>
        <div>
          블록: [<br />
          &amp;amp;nbsp;&amp;amp;nbsp;{"{"} 유형:{" "}
          <span style={{ color: "#87867f" }}>&quot;텍스트&quot;</span>, 텍스트: &quot;내가 할게
          읽어봐...&quot; {"}"},<br />
          &amp;amp;nbsp;&amp;amp;nbsp;{"{"} 유형:{" "}
          <span style={{ color: "#d97757" }}>&quot;도구_사용&quot;</span>, 이름: &quot;읽기&quot;,
          <br />
          &amp;nbsp;&amp;nbsp;&amp;nbsp;&amp;nbsp;입력: {"{"} 파일_경로: &quot;./config.ts&quot; {"}"}{" "}
          {"}"}
          <br />]
        </div>
      </StepVisual>
    ),
  },
  {
    id: 5,
    title: "도구 실행",
    shortTitle: "도구",
    description:
      "도구 호출은 14단계 파이프라인을 통해 실행됩니다. 읽기 전용 도구(Read, Glob, Grep)는 병렬로 실행됩니다. 쓰기 도구(Edit, Write, Bash)는 순차적으로 실행됩니다. 각각은 권한 확인을 거칩니다.",
    visual: (
      <StepVisual>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#22c55e",
                marginRight: 8,
              }}
            />
            읽기(&quot;./config.ts&quot;)
            <span style={{ color: "#22c55e", marginLeft: 8 }}>달리기</span>
          </div>
          <div>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#22c55e",
                marginRight: 8,
              }}
            />
            글로브(&quot;**/*.json&quot;)
            <span style={{ color: "#22c55e", marginLeft: 8 }}>달리기</span>
          </div>
          <div style={{ opacity: 0.5, fontSize: 11, marginTop: 2 }}>
            읽기 전용 도구는 병렬로 실행됩니다.
          </div>
        </div>
      </StepVisual>
    ),
  },
  {
    id: 6,
    title: "결과 수집",
    shortTitle: "결과",
    description:
      "도구 출력은 tool_result 메시지로 수집되고 형식화됩니다. 큰 출력은 메시지당 토큰 예산에 맞게 잘립니다. 결과는 tool_use ID와 쌍을 이룹니다.",
    visual: (
      <StepVisual>
        <div>
          {"{"} 역할:{" "}
          <span style={{ color: "#87867f" }}>&quot;도구_결과&quot;</span>,
          <br />
          &amp;amp;nbsp;&amp;amp;nbsp;tool_use_id: &amp;quot;toolu_01X...&amp;quot;,
          <br />
          &amp;nbsp;&amp;nbsp; 내용:{" "}
          <span style={{ color: "#d97757" }}>
            &quot;기본값 내보내기 {"{"} 포트: 3001... {"}"}"
          </span>
          <br />
          {"}"}
        </div>
      </StepVisual>
    ),
  },
  {
    id: 7,
    title: "후처리",
    shortTitle: "훅",
    description:
      "PostToolUse 훅가 실행되어 확장 프로그램이 결과를 검사하거나 수정할 수 있습니다. 시스템은 중지 조건을 확인합니다. 훅가 조기 종료를 요청했습니까? 모델이 정지 시퀀스에 도달했나요?",
    visual: (
      <StepVisual>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div>
            PostTool훅을 사용하세요:{" "}
            <span style={{ color: "#22c55e" }}>2개 등록됨</span>
          </div>
          <div>
            &amp;nbsp;&amp;nbsp;모든 유형 차단.ts{" "}
            <span style={{ color: "#22c55e" }}>합격</span>
          </div>
          <div>
            &amp;amp;nbsp;&amp;amp;nbsp;auto-compact.ts{" "}
            <span style={{ color: "#22c55e" }}>합격</span>
          </div>
          <div style={{ marginTop: 4 }}>
            정지 조건:{" "}
            <span style={{ color: "#87867f" }}>트리거된 항목 없음</span>
          </div>
        </div>
      </StepVisual>
    ),
  },
  {
    id: 8,
    title: "결정",
    shortTitle: "결정하다",
    description:
      "모델은 응답을 검사합니다. 보류 중인 도구 호출이 있는 경우 도구 결과를 사용하여 1단계로 되돌아갑니다. 정보가 충분하면 최종 텍스트 응답을 생성하고 종료됩니다.",
    visual: null, // handled specially
  },
];

// --- Component ---

interface Props {
  className?: string;
}

export default function AgentLoopSimulator({ className }: Props) {
  const [currentStep, setCurrentStep] = useState(0); // 0 = not started, 1-8 = steps
  const [decision, setDecision] = useState<"loop" | "exit" | null>(null);
  const [iteration, setIteration] = useState(1);
  const [autoPlay, setAutoPlay] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;

  // Dark mode detection
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

  // Auto-play
  useEffect(() => {
    if (!autoPlay) return;
    const interval = setInterval(() => {
      if (!autoPlayRef.current) return;
      setCurrentStep((prev) => {
        if (prev >= 8) {
          setAutoPlay(false);
          return prev;
        }
        return prev + 1;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [autoPlay]);

  const handleNext = useCallback(() => {
    if (currentStep < 8) {
      setCurrentStep((s) => s + 1);
      setDecision(null);
    }
  }, [currentStep]);

  const handlePrev = useCallback(() => {
    if (currentStep > 1) {
      setCurrentStep((s) => s - 1);
      setDecision(null);
    }
  }, [currentStep]);

  const handleReset = useCallback(() => {
    setCurrentStep(0);
    setDecision(null);
    setIteration(1);
    setAutoPlay(false);
  }, []);

  const handleDecision = useCallback(
    (d: "loop" | "exit") => {
      setDecision(d);
      if (d === "loop") {
        setTimeout(() => {
          setCurrentStep(1);
          setDecision(null);
          setIteration((i) => i + 1);
        }, 1500);
      }
    },
    [],
  );

  const colors = {
    active: "#d97757",
    completed: "rgba(217, 119, 87, 0.3)",
    upcoming: "#c2c0b6",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    border: isDark ? "#333" : "#c2c0b6",
    panelBg: isDark ? "rgba(30,30,28,0.5)" : "rgba(255,255,255,0.5)",
  };

  const getStepColor = (stepId: number) => {
    if (stepId === currentStep) return colors.active;
    if (stepId < currentStep) return colors.completed;
    return colors.upcoming;
  };

  const getStepTextColor = (stepId: number) => {
    if (stepId === currentStep) return colors.text;
    if (stepId < currentStep) return colors.active;
    return colors.textMuted;
  };

  const activeStep = steps.find((s) => s.id === currentStep);

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Iteration badge */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            color: colors.textMuted,
          }}
        >
          반복 {iteration}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: colors.textMuted,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(e) => {
                setAutoPlay(e.target.checked);
                if (e.target.checked && currentStep === 0) setCurrentStep(1);
              }}
              style={{ accentColor: colors.active }}
            />
            자동 재생
          </label>
        </div>
      </div>

      {/* Pipeline */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          overflowX: "auto",
          padding: "8px 4px",
          marginBottom: 24,
        }}
      >
        {steps.map((step, i) => (
          <div
            key={step.id}
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            {/* Node */}
            <div
              onClick={() => {
                setCurrentStep(step.id);
                setDecision(null);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                cursor: "pointer",
                gap: 6,
              }}
            >
              <motion.div
                animate={{
                  backgroundColor: getStepColor(step.id),
                  scale: step.id === currentStep ? 1.15 : 1,
                }}
                transition={{ duration: 0.3 }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: step.id <= currentStep ? "#fff" : colors.textMuted,
                  fontSize: 14,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {step.id}
              </motion.div>
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: getStepTextColor(step.id),
                  fontWeight: step.id === currentStep ? 600 : 400,
                  whiteSpace: "nowrap",
                  transition: "color 0.3s",
                }}
              >
                {step.shortTitle}
              </span>
            </div>
            {/* Connector */}
            {i < steps.length - 1 && (
              <div
                style={{
                  width: 24,
                  height: 2,
                  background:
                    step.id < currentStep ? colors.completed : colors.upcoming,
                  marginInline: 4,
                  marginBottom: 20,
                  transition: "background 0.3s",
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Detail panel */}
      <AnimatePresence mode="wait">
        {currentStep === 0 ? (
          <motion.div
            key="start"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: "32px 24px",
              textAlign: "center",
              background: colors.panelBg,
            }}
          >
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 8,
              }}
            >
              에이전트 루프
            </div>
            <div
              style={{
                fontSize: 14,
                color: colors.textMuted,
                marginBottom: 20,
                maxWidth: 480,
                marginInline: "auto",
                lineHeight: 1.6,
              }}
            >
              Claude Code의 핵심 루프를 한 번 반복해 보세요. 각각
              반복은 입력을 받고, 모델을 호출하고, 도구를 실행하고,
              계속할지 아니면 응답할지 결정합니다.
            </div>
            <button
              onClick={() => setCurrentStep(1)}
              style={{
                background: colors.active,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "10px 24px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              루프 시작
            </button>
          </motion.div>
        ) : activeStep && currentStep !== 8 ? (
          <motion.div
            key={`step-${currentStep}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 24,
              background: colors.panelBg,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.active,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              단계 {activeStep.id} 8개 중
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: colors.text,
                marginBottom: 10,
              }}
            >
              {activeStep.title}
            </div>
            <div
              style={{
                fontSize: 14,
                color: colors.textMuted,
                lineHeight: 1.7,
                marginBottom: 16,
                maxWidth: 600,
              }}
            >
              {activeStep.description}
            </div>
            <div style={{ color: colors.text }}>{activeStep.visual}</div>
          </motion.div>
        ) : currentStep === 8 ? (
          <motion.div
            key="decision"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 24,
              background: colors.panelBg,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.active,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              8단계 중 8단계
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: colors.text,
                marginBottom: 10,
              }}
            >
              결정
            </div>
            <div
              style={{
                fontSize: 14,
                color: colors.textMuted,
                lineHeight: 1.7,
                marginBottom: 20,
                maxWidth: 600,
              }}
            >
              {steps[7].description}
            </div>

            {decision === null ? (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => handleDecision("loop")}
                  style={{
                    background: "transparent",
                    border: `2px solid ${colors.active}`,
                    color: colors.active,
                    borderRadius: 8,
                    padding: "10px 20px",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ flexShrink: 0 }}
                  >
                    <path
                      d="M2 8a6 6 0 0 1 10.47-4.03L10 6h5V1l-2.11 2.11A7.98 7.98 0 0 0 0 8h2z"
                      fill="currentColor"
                    />
                  </svg>
                  루프백(추가 도구 호출)
                </button>
                <button
                  onClick={() => handleDecision("exit")}
                  style={{
                    background: colors.active,
                    border: `2px solid ${colors.active}`,
                    color: "#fff",
                    borderRadius: 8,
                    padding: "10px 20px",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ flexShrink: 0 }}
                  >
                    <path
                      d="M3 8h8m0 0L7 4m4 4L7 12"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  종료(사용자에게 응답)
                </button>
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                style={{
                  padding: "16px 20px",
                  borderRadius: 8,
                  background:
                    decision === "loop"
                      ? "rgba(217, 119, 87, 0.1)"
                      : "rgba(34, 197, 94, 0.1)",
                  border: `1px solid ${decision === "loop" ? "rgba(217, 119, 87, 0.3)" : "rgba(34, 197, 94, 0.3)"}`,
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: colors.text,
                    marginBottom: 4,
                  }}
                >
                  {decision === "loop"
                    ? "반복 완료 - 1단계로 다시 반복"
                    : "반복 완료 - 사용자에게 응답"}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: colors.textMuted,
                  }}
                >
                  {decision === "loop"
                    ? `The model needs more information. Starting iteration ${iteration + 1}...`
                    : "모델은 충분한 정보를 수집했으며 최종 응답을 생성하고 있습니다."}
                </div>
                {decision === "exit" && (
                  <button
                    onClick={handleReset}
                    style={{
                      marginTop: 12,
                      background: "transparent",
                      border: `1px solid ${colors.border}`,
                      color: colors.textMuted,
                      borderRadius: 6,
                      padding: "6px 14px",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    다시 시작하세요
                  </button>
                )}
              </motion.div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Controls */}
      {currentStep > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 16,
          }}
        >
          <button
            onClick={handlePrev}
            disabled={currentStep <= 1}
            style={{
              background: "transparent",
              border: `1px solid ${colors.border}`,
              color: currentStep <= 1 ? colors.upcoming : colors.text,
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 13,
              cursor: currentStep <= 1 ? "default" : "pointer",
              fontFamily: "var(--font-mono)",
              opacity: currentStep <= 1 ? 0.4 : 1,
            }}
          >
            이전
          </button>
          <button
            onClick={handleReset}
            style={{
              background: "transparent",
              border: "none",
              color: colors.textMuted,
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            재설정
          </button>
          <button
            onClick={handleNext}
            disabled={currentStep >= 8}
            style={{
              background:
                currentStep >= 8 ? colors.upcoming : colors.active,
              border: "none",
              color: "#fff",
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 13,
              cursor: currentStep >= 8 ? "default" : "pointer",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              opacity: currentStep >= 8 ? 0.4 : 1,
            }}
          >
            다음 단계
          </button>
        </div>
      )}
    </div>
  );
}
