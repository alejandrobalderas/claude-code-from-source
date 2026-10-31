import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Data ---

interface Phase {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  description: string;
  details: string;
}

interface ParallelOp {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  description: string;
}

const phases: Phase[] = [
  {
    id: "fast-path",
    label: "빠른 경로 확인",
    startMs: 0,
    endMs: 5,
    description: "--version, --help를 확인하세요.",
    details:
      "일치하면 즉시 응답하고 종료합니다. 모듈 로딩이나 I/O가 없습니다. 이것이 `claude --version`이 즉시 반환되는 이유입니다.",
  },
  {
    id: "module-loading",
    label: "모듈 로딩",
    startMs: 0,
    endMs: 80,
    description: "모든 TypeScript 모듈 가져오기",
    details:
      "모듈 수준의 부작용은 평가 중에 I/O를 실행합니다. 이것이 핵심 통찰력입니다. I/O가 가져오기 해결과 겹칩니다.",
  },
  {
    id: "init",
    label: "초기화()",
    startMs: 80,
    endMs: 95,
    description: "인수 구문 분석, 구성 해결",
    details:
      "신뢰 경계를 설정합니다. 세션 유형(REPL 대 원샷)을 결정합니다. 이 단계 후에는 구성이 동결됩니다.",
  },
  {
    id: "setup",
    label: "설정()",
    startMs: 95,
    endMs: 130,
    description: "로드 명령, 에이전트, 훅, 플러그인",
    details:
      "git 상태 및 CLAUDE.md 읽기를 위한 병렬 I/O입니다. 모듈 수준 I/O의 결과가 여기에서 기다리고 있습니다. 이미 완료되었습니다.",
  },
  {
    id: "first-call",
    label: "첫 번째 API 호출",
    startMs: 130,
    endMs: 240,
    description: "미리 준비된 TCP+TLS 연결",
    details:
      "시스템 신속한 구축 및 모델에 대한 최초 요청. 모듈 로딩 중에 TCP+TLS 핸드셰이크가 이미 완료되었습니다.",
  },
];

const parallelOps: ParallelOp[] = [
  {
    id: "git-status",
    label: "자식 상태",
    startMs: 10,
    endMs: 60,
    description:
      "모듈 평가 중에 생성된 하위 프로세스입니다. 결과가 캐시되어 setup()에서 대기됩니다.",
  },
  {
    id: "claude-md",
    label: "CLAUDE.md 읽기",
    startMs: 15,
    endMs: 40,
    description:
      "모듈 수준의 부작용으로 파일 읽기가 발생했습니다. 시스템 프롬프트 구축에 사용되는 컨텐츠입니다.",
  },
  {
    id: "tcp-tls",
    label: "TCP+TLS 사전 연결",
    startMs: 20,
    endMs: 100,
    description:
      "모듈 로딩 중에 미리 예열된 Anthropic API에 대한 연결입니다. 첫 번째 API 호출 전에 준비되었습니다.",
  },
];

const TOTAL_MS = 240;
const SEQUENTIAL_MS = 800;

// --- Hooks ---

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

// --- Component ---

interface Props {
  className?: string;
}

interface TooltipData {
  x: number;
  y: number;
  label: string;
  description: string;
  details?: string;
  startMs: number;
  endMs: number;
}

export default function BootstrapTimeline({ className }: Props) {
  const isDark = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to 1
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const ANIMATION_DURATION = 2400; // ms for full playback

  const colors = {
    phase: "#d97757",
    phaseLight: isDark ? "#d9775733" : "#d9775722",
    parallel: "rgba(217, 119, 87, 0.4)",
    cursor: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    border: isDark ? "#333" : "#c2c0b6",
    gridLine: isDark ? "rgba(135,134,127,0.15)" : "rgba(135,134,127,0.2)",
  };

  const play = useCallback(() => {
    setPlaying(true);
    setProgress(0);
    startTimeRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const p = Math.min(elapsed / ANIMATION_DURATION, 1);
      setProgress(p);
      if (p < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };
    animRef.current = requestAnimationFrame(tick);
  }, []);

  const reset = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setPlaying(false);
    setProgress(0);
  }, []);

  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, []);

  const cursorMs = progress * TOTAL_MS;

  // Layout constants
  const LEFT_LABEL_WIDTH = 140;
  const CHART_PADDING_RIGHT = 16;
  const ROW_HEIGHT = 36;
  const PHASE_ROWS = phases.length;
  const GAP_ROW = 0.5;
  const PARALLEL_ROWS = parallelOps.length;
  const HEADER_HEIGHT = 24;

  const totalRows = PHASE_ROWS + GAP_ROW + PARALLEL_ROWS;
  const chartHeight = HEADER_HEIGHT + totalRows * ROW_HEIGHT + 16;

  const barX = (ms: number, chartWidth: number) =>
    LEFT_LABEL_WIDTH + (ms / TOTAL_MS) * (chartWidth - LEFT_LABEL_WIDTH - CHART_PADDING_RIGHT);

  const barWidth = (startMs: number, endMs: number, chartWidth: number) =>
    ((endMs - startMs) / TOTAL_MS) * (chartWidth - LEFT_LABEL_WIDTH - CHART_PADDING_RIGHT);

  const handleBarHover = (
    e: React.MouseEvent,
    item: Phase | ParallelOp,
    isPhase: boolean,
  ) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top - 12,
      label: item.label,
      description: item.description,
      details: isPhase ? (item as Phase).details : undefined,
      startMs: item.startMs,
      endMs: item.endMs,
    });
  };

  const handleBarMove = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip((prev) =>
      prev
        ? { ...prev, x: e.clientX - rect.left, y: e.clientY - rect.top - 12 }
        : null,
    );
  };

  // Tick marks
  const ticks = [0, 50, 100, 150, 200, 240];

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", fontFamily: "var(--font-serif)" }}
    >
      {/* Comparison badge */}
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "center",
          marginBottom: 16,
          flexWrap: "wrap",
          fontSize: 13,
        }}
      >
        <span
          style={{
            background: isDark ? "#2a2a28" : "#f0efe8",
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: "4px 12px",
            color: colors.textSecondary,
          }}
        >
          순차: <span style={{ textDecoration: "line-through" }}>~{SEQUENTIAL_MS}ms</span>
        </span>
        <span
          style={{
            background: isDark ? "rgba(217,119,87,0.15)" : "rgba(217,119,87,0.1)",
            border: `1px solid ${colors.phase}`,
            borderRadius: 6,
            padding: "4px 12px",
            color: colors.phase,
            fontWeight: 600,
          }}
        >
          병렬: ~{TOTAL_MS}ms{" "}
          <span style={{ fontWeight: 400, opacity: 0.8 }}>
            ({Math.round((1 - TOTAL_MS / SEQUENTIAL_MS) * 100)}% 더 빠름)
          </span>
        </span>
      </div>

      {/* Chart */}
      <div
        style={{
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: "16px 0 8px 0",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <svg
          width="100%"
          viewBox={`0 0 700 ${chartHeight}`}
          style={{ display: "block" }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Tick marks */}
          {ticks.map((ms) => {
            const x = barX(ms, 700);
            return (
              <g key={ms}>
                <line
                  x1={x}
                  y1={HEADER_HEIGHT - 4}
                  x2={x}
                  y2={chartHeight - 8}
                  stroke={colors.gridLine}
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
                <text
                  x={x}
                  y={HEADER_HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill={colors.textSecondary}
                  fontFamily="var(--font-mono)"
                >
                  {ms}ms
                </text>
              </g>
            );
          })}

          {/* Section label: Phases */}
          <text
            x={8}
            y={HEADER_HEIGHT + 6}
            fontSize={9}
            fill={colors.textSecondary}
            fontFamily="var(--font-mono)"
            textTransform="uppercase"
            letterSpacing={1}
          >
            단계
          </text>

          {/* Phase bars */}
          {phases.map((phase, i) => {
            const y = HEADER_HEIGHT + 12 + i * ROW_HEIGHT;
            const x = barX(phase.startMs, 700);
            const w = barWidth(phase.startMs, phase.endMs, 700);
            const visible =
              progress > 0 &&
              cursorMs >= phase.startMs;
            const fillWidth = visible
              ? Math.min(w, barWidth(phase.startMs, Math.min(cursorMs, phase.endMs), 700))
              : 0;

            return (
              <g
                key={phase.id}
                onMouseEnter={(e) => handleBarHover(e, phase, true)}
                onMouseMove={handleBarMove}
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: "pointer" }}
              >
                {/* Row label */}
                <text
                  x={LEFT_LABEL_WIDTH - 8}
                  y={y + ROW_HEIGHT / 2 + 1}
                  textAnchor="end"
                  fontSize={12}
                  fill={colors.text}
                  fontFamily="var(--font-serif)"
                  dominantBaseline="middle"
                >
                  {phase.label}
                </text>
                {/* Background bar */}
                <rect
                  x={x}
                  y={y + 4}
                  width={w}
                  height={ROW_HEIGHT - 8}
                  rx={4}
                  fill={colors.phaseLight}
                />
                {/* Animated fill */}
                {progress > 0 && (
                  <rect
                    x={x}
                    y={y + 4}
                    width={fillWidth}
                    height={ROW_HEIGHT - 8}
                    rx={4}
                    fill={colors.phase}
                    opacity={0.85}
                  />
                )}
                {/* Duration label */}
                <text
                  x={x + w + 6}
                  y={y + ROW_HEIGHT / 2 + 1}
                  fontSize={10}
                  fill={colors.textSecondary}
                  fontFamily="var(--font-mono)"
                  dominantBaseline="middle"
                >
                  {phase.endMs - phase.startMs}ms
                </text>
              </g>
            );
          })}

          {/* Section label: Parallel I/O */}
          <text
            x={8}
            y={HEADER_HEIGHT + (PHASE_ROWS + GAP_ROW) * ROW_HEIGHT + 18}
            fontSize={9}
            fill={colors.textSecondary}
            fontFamily="var(--font-mono)"
            textTransform="uppercase"
            letterSpacing={1}
          >
            병렬 I/O
          </text>

          {/* Parallel operation bars */}
          {parallelOps.map((op, i) => {
            const y =
              HEADER_HEIGHT +
              12 +
              (PHASE_ROWS + GAP_ROW) * ROW_HEIGHT +
              12 +
              i * ROW_HEIGHT;
            const x = barX(op.startMs, 700);
            const w = barWidth(op.startMs, op.endMs, 700);
            const visible =
              progress > 0 && cursorMs >= op.startMs;
            const fillWidth = visible
              ? Math.min(w, barWidth(op.startMs, Math.min(cursorMs, op.endMs), 700))
              : 0;

            return (
              <g
                key={op.id}
                onMouseEnter={(e) => handleBarHover(e, op, false)}
                onMouseMove={handleBarMove}
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: "pointer" }}
              >
                {/* Row label */}
                <text
                  x={LEFT_LABEL_WIDTH - 8}
                  y={y + ROW_HEIGHT / 2 + 1}
                  textAnchor="end"
                  fontSize={12}
                  fill={colors.text}
                  fontFamily="var(--font-serif)"
                  dominantBaseline="middle"
                  fontStyle="italic"
                >
                  {op.label}
                </text>
                {/* Background bar */}
                <rect
                  x={x}
                  y={y + 4}
                  width={w}
                  height={ROW_HEIGHT - 8}
                  rx={4}
                  fill={colors.phaseLight}
                />
                {/* Animated fill */}
                {progress > 0 && (
                  <rect
                    x={x}
                    y={y + 4}
                    width={fillWidth}
                    height={ROW_HEIGHT - 8}
                    rx={4}
                    fill={colors.parallel}
                  />
                )}
                {/* Hatching pattern to distinguish from phases */}
                <rect
                  x={x}
                  y={y + 4}
                  width={progress > 0 ? fillWidth : 0}
                  height={ROW_HEIGHT - 8}
                  rx={4}
                  fill="url(#diagonal-hatch)"
                  opacity={0.3}
                />
                {/* Duration label */}
                <text
                  x={x + w + 6}
                  y={y + ROW_HEIGHT / 2 + 1}
                  fontSize={10}
                  fill={colors.textSecondary}
                  fontFamily="var(--font-mono)"
                  dominantBaseline="middle"
                >
                  {op.endMs - op.startMs}ms
                </text>
              </g>
            );
          })}

          {/* Hatching pattern def */}
          <defs>
            <pattern
              id="diagonal-hatch"
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
            >
              <path
                d="M0,6 l6,-6 M-1,1 l2,-2 M5,7 l2,-2"
                stroke={colors.phase}
                strokeWidth={1}
                opacity={0.5}
              />
            </pattern>
          </defs>

          {/* Cursor line */}
          {progress > 0 && (
            <line
              x1={barX(cursorMs, 700)}
              y1={HEADER_HEIGHT - 4}
              x2={barX(cursorMs, 700)}
              y2={chartHeight - 8}
              stroke={colors.cursor}
              strokeWidth={2}
              opacity={0.9}
            />
          )}
          {progress > 0 && (
            <text
              x={barX(cursorMs, 700)}
              y={chartHeight - 1}
              textAnchor="middle"
              fontSize={10}
              fill={colors.cursor}
              fontFamily="var(--font-mono)"
              fontWeight={600}
            >
              {Math.round(cursorMs)}ms
            </text>
          )}
        </svg>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          marginTop: 12,
        }}
      >
        <button
          onClick={play}
          disabled={playing}
          style={{
            background: playing ? colors.textSecondary : colors.phase,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "6px 18px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            cursor: playing ? "not-allowed" : "pointer",
            opacity: playing ? 0.5 : 1,
            transition: "opacity 0.2s",
          }}
        >
          플레이
        </button>
        <button
          onClick={reset}
          style={{
            background: "transparent",
            color: colors.textSecondary,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: "6px 18px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
          }}
        >
          재설정
        </button>
      </div>

      {/* Tooltip */}
      <AnimatePresence>
        {tooltip && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              position: "absolute",
              left: tooltip.x,
              top: tooltip.y,
              transform: "translate(-50%, -100%)",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              padding: "10px 14px",
              maxWidth: 280,
              pointerEvents: "none",
              zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: colors.text,
                marginBottom: 2,
                fontFamily: "var(--font-serif)",
              }}
            >
              {tooltip.label}
            </div>
            <div
              style={{
                fontSize: 11,
                color: colors.phase,
                marginBottom: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              {tooltip.startMs}ms - {tooltip.endMs}ms ({tooltip.endMs - tooltip.startMs}ms)
            </div>
            <div
              style={{
                fontSize: 12,
                color: colors.textSecondary,
                lineHeight: 1.5,
                fontFamily: "var(--font-serif)",
              }}
            >
              {tooltip.details || tooltip.description}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          marginTop: 10,
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-serif)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: colors.phase,
              display: "inline-block",
              opacity: 0.85,
            }}
          />
          파이프라인 단계
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: colors.parallel,
              display: "inline-block",
            }}
          />
          병렬 I/O(중복)
        </span>
        <span>자세한 내용을 보려면 막대를 가리키세요.</span>
      </div>
    </div>
  );
}
