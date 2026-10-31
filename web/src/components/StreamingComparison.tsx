import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type BlockKind = "model" | "read" | "write" | "idle";

interface TimelineBlock {
  label: string;
  kind: BlockKind;
  startTime: number;
  endTime: number;
}

// --- Data ---

const sequentialBlocks: TimelineBlock[] = [
  { label: "모델이 응답을 생성합니다", kind: "model", startTime: 0, endTime: 3 },
  { label: "도구 1: 파일 읽기", kind: "read", startTime: 3, endTime: 4.5 },
  { label: "도구 2: 파일 읽기", kind: "read", startTime: 4.5, endTime: 6 },
  { label: "도구 3: 파일 쓰기", kind: "write", startTime: 6, endTime: 8 },
];

const streamingBlocks: TimelineBlock[] = [
  { label: "모델 스트리밍...", kind: "model", startTime: 0, endTime: 3 },
  { label: "도구 1: 파일 읽기(추측)", kind: "read", startTime: 1, endTime: 2.5 },
  { label: "도구 2: 파일 읽기(추측)", kind: "read", startTime: 2, endTime: 3.5 },
  { label: "도구 3: 파일 쓰기", kind: "write", startTime: 3, endTime: 5 },
];

const SEQUENTIAL_TOTAL = 8;
const STREAMING_TOTAL = 5;
const MAX_TIME = 8;

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

function getBlockColor(kind: BlockKind, isDark: boolean): string {
  switch (kind) {
    case "model":
      return "#d97757";
    case "read":
      return "#87867f";
    case "write":
      return isDark ? "#d4a24e" : "#c4922e";
    case "idle":
      return isDark ? "#333" : "#e8e6dc";
  }
}

function getBlockBorderColor(kind: BlockKind, isDark: boolean): string {
  switch (kind) {
    case "model":
      return "rgba(217, 119, 87, 0.6)";
    case "read":
      return "rgba(135, 134, 127, 0.6)";
    case "write":
      return isDark ? "rgba(212, 162, 78, 0.6)" : "rgba(196, 146, 46, 0.6)";
    case "idle":
      return isDark ? "#444" : "#c2c0b6";
  }
}

// --- Icons ---

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 1.5L12 7L3 12.5V1.5Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
      <rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M2 7C2 4.24 4.24 2 7 2C9.76 2 12 4.24 12 7C12 9.76 9.76 12 7 12C5.62 12 4.38 11.44 3.5 10.54"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M2 4V7H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function StreamingComparison({ className }: Props) {
  const isDark = useDarkMode();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const animFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    playhead: "#d97757",
    timeAxis: isDark ? "#444" : "#c2c0b6",
    badge: "#d97757",
  };

  const tick = useCallback(() => {
    const now = performance.now();
    if (lastTickRef.current !== null) {
      const delta = (now - lastTickRef.current) / 1000;
      setCurrentTime((prev) => {
        const next = prev + delta * speed;
        if (next >= MAX_TIME) {
          setIsPlaying(false);
          return MAX_TIME;
        }
        return next;
      });
    }
    lastTickRef.current = now;
    animFrameRef.current = requestAnimationFrame(tick);
  }, [speed]);

  useEffect(() => {
    if (isPlaying) {
      lastTickRef.current = performance.now();
      animFrameRef.current = requestAnimationFrame(tick);
    } else {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
      lastTickRef.current = null;
    }
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isPlaying, tick]);

  const handleReset = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const togglePlay = () => {
    if (currentTime >= MAX_TIME) {
      setCurrentTime(0);
    }
    setIsPlaying((p) => !p);
  };

  // Timeline rendering dimensions
  const timelineHeight = 320;
  const blockAreaTop = 8;
  const pxPerSecond = (timelineHeight - blockAreaTop) / MAX_TIME;

  const renderTimeline = (
    blocks: TimelineBlock[],
    label: string,
    totalTime: number
  ) => {
    const isFinished = currentTime >= totalTime;
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: colors.text,
            marginBottom: 12,
            textAlign: "center",
            fontFamily: "var(--font-serif)",
          }}
        >
          {label}
        </div>

        {/* Timeline area */}
        <div
          style={{
            position: "relative",
            height: timelineHeight,
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 10,
            overflow: "hidden",
            padding: "0 12px",
          }}
        >
          {/* Time axis labels */}
          {Array.from({ length: MAX_TIME + 1 }, (_, sec) => (
            <div
              key={sec}
              style={{
                position: "absolute",
                left: 4,
                top: blockAreaTop + sec * pxPerSecond - 6,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                opacity: 0.6,
              }}
            >
              {sec}s
            </div>
          ))}

          {/* Time grid lines */}
          {Array.from({ length: MAX_TIME + 1 }, (_, sec) => (
            <div
              key={sec}
              style={{
                position: "absolute",
                left: 28,
                right: 8,
                top: blockAreaTop + sec * pxPerSecond,
                height: 1,
                background: colors.timeAxis,
                opacity: 0.3,
              }}
            />
          ))}

          {/* Blocks */}
          {blocks.map((block, idx) => {
            const top = blockAreaTop + block.startTime * pxPerSecond;
            const height = (block.endTime - block.startTime) * pxPerSecond;
            const isActive =
              currentTime >= block.startTime && currentTime < block.endTime;
            const isDone = currentTime >= block.endTime;
            const isUpcoming = currentTime < block.startTime;

            return (
              <div
                key={idx}
                style={{
                  position: "absolute",
                  left: 32,
                  right: 12,
                  top,
                  height,
                  borderRadius: 6,
                  background: getBlockColor(block.kind, isDark),
                  border: `1px solid ${getBlockBorderColor(block.kind, isDark)}`,
                  opacity: isUpcoming ? 0.2 : isDone ? 0.7 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 6px",
                  transition: "opacity 0.2s",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: block.kind === "model" ? "#fff" : isDark ? "#f5f4ed" : "#fff",
                    textAlign: "center",
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {block.label}
                </span>
                {/* Pulse for active block */}
                {isActive && (
                  <motion.div
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 6,
                      border: "2px solid rgba(255,255,255,0.4)",
                    }}
                    animate={{ opacity: [0.4, 0, 0.4] }}
                    transition={{ duration: 1, repeat: Infinity }}
                  />
                )}
              </div>
            );
          })}

          {/* Playhead */}
          {currentTime > 0 && currentTime <= MAX_TIME && (
            <motion.div
              style={{
                position: "absolute",
                left: 28,
                right: 8,
                top: blockAreaTop + currentTime * pxPerSecond,
                height: 2,
                background: colors.playhead,
                zIndex: 5,
                borderRadius: 1,
              }}
              layout
            />
          )}

          {/* Completion line */}
          <div
            style={{
              position: "absolute",
              left: 28,
              right: 8,
              top: blockAreaTop + totalTime * pxPerSecond,
              height: 1,
              background: isFinished ? colors.badge : "transparent",
              borderStyle: isFinished ? "solid" : "dashed",
              borderWidth: isFinished ? 0 : "1px 0 0 0",
              borderColor: colors.textSecondary,
              opacity: 0.5,
            }}
          />
        </div>

        {/* Total time */}
        <AnimatePresence>
          {currentTime >= totalTime && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              style={{
                marginTop: 10,
                textAlign: "center",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.badge,
              }}
            >
              {totalTime.toFixed(1)}s
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  const sequentialDone = currentTime >= SEQUENTIAL_TOTAL;
  const streamingDone = currentTime >= STREAMING_TOTAL;
  const bothDone = sequentialDone && streamingDone;

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: "#d97757",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
          }}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
          {isPlaying ? "일시중지" : "플레이"}
        </button>

        {/* Reset */}
        <button
          onClick={handleReset}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${colors.cardBorder}`,
            background: "transparent",
            color: colors.text,
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
          }}
        >
          <ResetIcon />
          재설정
        </button>

        {/* Speed control */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
          <span style={{ fontSize: 12, color: colors.textSecondary, fontFamily: "var(--font-mono)" }}>
            속도:
          </span>
          {[1, 2].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${speed === s ? "#d97757" : colors.cardBorder}`,
                background: speed === s ? (isDark ? "rgba(217,119,87,0.15)" : "rgba(217,119,87,0.1)") : "transparent",
                color: speed === s ? "#d97757" : colors.textSecondary,
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                fontWeight: speed === s ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Time indicator */}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
          }}
        >
          {currentTime.toFixed(1)}s / {MAX_TIME}s
        </span>
      </div>

      {/* Timelines side by side */}
      <div style={{ display: "flex", gap: 16 }}>
        {renderTimeline(sequentialBlocks, "Sequential", SEQUENTIAL_TOTAL)}
        {renderTimeline(streamingBlocks, "Streaming (Speculative)", STREAMING_TOTAL)}
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          marginTop: 16,
          flexWrap: "wrap",
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-mono)",
        }}
      >
        {[
          { label: "모델 스트리밍", color: "#d97757" },
          { label: "읽기 전용 도구", color: "#87867f" },
          { label: "쓰기 도구", color: isDark ? "#d4a24e" : "#c4922e" },
        ].map((item) => (
          <span key={item.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: item.color,
                display: "inline-block",
              }}
            />
            {item.label}
          </span>
        ))}
      </div>

      {/* Speed comparison badge */}
      <AnimatePresence>
        {bothDone && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            style={{
              marginTop: 20,
              padding: "14px 20px",
              borderRadius: 12,
              border: `1px solid rgba(217, 119, 87, 0.4)`,
              background: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              flexWrap: "wrap",
              fontFamily: "var(--font-mono)",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 12, color: colors.textSecondary }}>순차</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>{SEQUENTIAL_TOTAL}s</div>
            </div>
            <div style={{ fontSize: 20, color: colors.textSecondary }}>대</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 12, color: colors.textSecondary }}>스트리밍</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#d97757" }}>{STREAMING_TOTAL}s</div>
            </div>
            <div
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                background: "#d97757",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {(SEQUENTIAL_TOTAL / STREAMING_TOTAL).toFixed(1)}x 더 빠르게
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
