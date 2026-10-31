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

interface State {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
}

interface Arrow {
  from: string;
  to: string;
  label: string;
  curve?: number;
}

const states: State[] = [
  { id: "queued", label: "대기 중", x: 100, y: 110, color: "#87867f" },
  { id: "executing", label: "실행", x: 300, y: 110, color: "#d97757" },
  { id: "completed", label: "완료", x: 500, y: 50, color: "#4ade80" },
  { id: "error", label: "오류", x: 500, y: 170, color: "#ef4444" },
  { id: "cancelled", label: "취소됨", x: 100, y: 220, color: "#f59e0b" },
];

const arrows: Arrow[] = [
  { from: "queued", to: "executing", label: "동시성 검사 통과" },
  { from: "executing", to: "completed", label: "call() 완료" },
  { from: "executing", to: "error", label: "예외가 발생했습니다." },
  { from: "queued", to: "cancelled", label: "중단 신호" },
];

const stateMap = Object.fromEntries(states.map((s) => [s.id, s]));

const RADIUS = 36;

interface Props {
  className?: string;
}

export default function ToolLifecycle({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    connector: isDark ? "#555" : "#c2c0b6",
  };

  function getArrowPath(from: State, to: State): { path: string; labelX: number; labelY: number; angle: number } {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / dist;
    const ny = dy / dist;

    const x1 = from.x + nx * RADIUS;
    const y1 = from.y + ny * RADIUS;
    const x2 = to.x - nx * (RADIUS + 8);
    const y2 = to.y - ny * (RADIUS + 8);

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

    return {
      path: `M${x1},${y1} L${x2},${y2}`,
      labelX: midX,
      labelY: midY - 10,
      angle,
    };
  }

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <div
        style={{
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          padding: "20px 12px",
          overflow: "hidden",
        }}
      >
        <svg
          width="100%"
          viewBox="0 0 600 270"
          style={{ display: "block" }}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <marker
              id="tool-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="8"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill={colors.connector} />
            </marker>
            {states.map((s) => (
              <marker
                key={`arrow-${s.id}`}
                id={`tool-arrow-${s.id}`}
                markerWidth="8"
                markerHeight="8"
                refX="8"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 Z" fill={`${s.color}80`} />
              </marker>
            ))}
          </defs>

          {/* Arrows */}
          {arrows.map((arrow) => {
            const from = stateMap[arrow.from];
            const to = stateMap[arrow.to];
            const { path, labelX, labelY } = getArrowPath(from, to);

            return (
              <motion.g
                key={`${arrow.from}-${arrow.to}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.3 }}
              >
                <path
                  d={path}
                  fill="none"
                  stroke={`${to.color}60`}
                  strokeWidth={1.5}
                  markerEnd={`url(#tool-arrow-${to.id})`}
                />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  fontSize={10}
                  fill={colors.textSecondary}
                  fontFamily="var(--font-mono)"
                >
                  {arrow.label}
                </text>
              </motion.g>
            );
          })}

          {/* State circles */}
          {states.map((state, i) => (
            <motion.g
              key={state.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, delay: i * 0.08 }}
            >
              {/* Glow ring */}
              <circle
                cx={state.x}
                cy={state.y}
                r={RADIUS + 4}
                fill="none"
                stroke={state.color}
                strokeWidth={1}
                opacity={0.2}
              />

              {/* Main circle */}
              <circle
                cx={state.x}
                cy={state.y}
                r={RADIUS}
                fill={isDark ? `${state.color}12` : `${state.color}10`}
                stroke={state.color}
                strokeWidth={2}
              />

              {/* Label */}
              <text
                x={state.x}
                y={state.y + 4}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={state.color}
                fontFamily="var(--font-mono)"
              >
                {state.label}
              </text>
            </motion.g>
          ))}

          {/* Start arrow into "queued" */}
          <motion.g
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            <line
              x1={20}
              y1={110}
              x2={100 - RADIUS - 8}
              y2={110}
              stroke={colors.connector}
              strokeWidth={1.5}
              markerEnd="url(#tool-arrow)"
            />
            <text
              x={20}
              y={100}
              fontSize={10}
              fill={colors.textSecondary}
              fontFamily="var(--font-mono)"
            >
              대기열에 넣다
            </text>
          </motion.g>
        </svg>
      </div>
    </div>
  );
}
