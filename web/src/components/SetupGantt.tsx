import { useState, useEffect } from "react";
import { motion } from "framer-motion";

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

interface GanttItem {
  label: string;
  startMs: number;
  endMs: number;
  color: string;
}

const items: GanttItem[] = [
  { label: "명령 로드 중", startMs: 0, endMs: 10, color: "#d97757" },
  { label: "에이전트 로딩", startMs: 0, endMs: 8, color: "#f59e0b" },
  { label: "훅 로딩", startMs: 2, endMs: 12, color: "#4ade80" },
  { label: "플러그인 로딩", startMs: 5, endMs: 15, color: "#a78bfa" },
  { label: "MCP 초기화", startMs: 8, endMs: 25, color: "#60a5fa" },
];

const MAX_MS = 30;
const TICKS = [0, 5, 10, 15, 20, 25, 30];

interface Props {
  className?: string;
}

export default function SetupGantt({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    gridLine: isDark ? "rgba(135,134,127,0.15)" : "rgba(135,134,127,0.2)",
    terracotta: "#d97757",
  };

  const LABEL_WIDTH = 130;
  const CHART_WIDTH = 600;
  const BAR_AREA = CHART_WIDTH - LABEL_WIDTH - 20;
  const ROW_HEIGHT = 40;
  const HEADER = 24;
  const chartHeight = HEADER + items.length * ROW_HEIGHT + 12;

  const msToX = (ms: number) => LABEL_WIDTH + (ms / MAX_MS) * BAR_AREA;

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <div
        style={{
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          padding: "16px 12px 8px",
          overflow: "hidden",
        }}
      >
        <svg
          width="100%"
          viewBox={`0 0 ${CHART_WIDTH} ${chartHeight}`}
          style={{ display: "block" }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Tick marks and grid lines */}
          {TICKS.map((ms) => {
            const x = msToX(ms);
            return (
              <g key={ms}>
                <line
                  x1={x}
                  y1={HEADER}
                  x2={x}
                  y2={chartHeight - 8}
                  stroke={colors.gridLine}
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
                <text
                  x={x}
                  y={HEADER - 6}
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

          {/* Bars */}
          {items.map((item, i) => {
            const y = HEADER + 4 + i * ROW_HEIGHT;
            const x = msToX(item.startMs);
            const w = (item.endMs - item.startMs) / MAX_MS * BAR_AREA;

            return (
              <g key={item.label}>
                {/* Label */}
                <text
                  x={LABEL_WIDTH - 10}
                  y={y + ROW_HEIGHT / 2}
                  textAnchor="end"
                  fontSize={12}
                  fill={colors.text}
                  fontFamily="var(--font-serif)"
                  dominantBaseline="middle"
                >
                  {item.label}
                </text>

                {/* Bar background */}
                <motion.rect
                  initial={{ width: 0 }}
                  animate={{ width: w }}
                  transition={{ duration: 0.5, delay: 0.1 + i * 0.08 }}
                  x={x}
                  y={y + 8}
                  height={ROW_HEIGHT - 16}
                  rx={6}
                  fill={`${item.color}30`}
                  stroke={item.color}
                  strokeWidth={1.5}
                />

                {/* Bar fill */}
                <motion.rect
                  initial={{ width: 0 }}
                  animate={{ width: w }}
                  transition={{ duration: 0.5, delay: 0.1 + i * 0.08 }}
                  x={x}
                  y={y + 8}
                  height={ROW_HEIGHT - 16}
                  rx={6}
                  fill={item.color}
                  opacity={0.35}
                />

                {/* Duration label */}
                <motion.text
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.4 + i * 0.08 }}
                  x={x + w + 8}
                  y={y + ROW_HEIGHT / 2}
                  fontSize={10}
                  fill={colors.textSecondary}
                  fontFamily="var(--font-mono)"
                  dominantBaseline="middle"
                >
                  {item.endMs - item.startMs}ms
                </motion.text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Annotation */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.3 }}
        style={{
          display: "flex",
          justifyContent: "center",
          marginTop: 10,
          gap: 16,
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>
          총 벽 시간:{" "}
          <span style={{ color: colors.terracotta, fontWeight: 600 }}>~25ms</span>
        </span>
        <span style={{ opacity: 0.5 }}>|</span>
        <span>
          순차적은 다음과 같습니다.{" "}
          <span style={{ textDecoration: "line-through" }}>~70ms</span>
        </span>
      </motion.div>
    </div>
  );
}
