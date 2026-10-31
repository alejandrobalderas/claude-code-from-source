import { useEffect, useState } from "react";
import { motion } from "framer-motion";

// --- Dark Mode Hook ---

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

// --- Colors ---

function getColors(isDark: boolean) {
  return {
    bg: isDark ? "#1e1e1c" : "#ffffff",
    surface: isDark ? "#2a2a28" : "#f5f4ed",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#444" : "#c2c0b6",
    terracotta: "#d97757",
  };
}

// --- Node Types ---

type NodeKind = "action" | "decision" | "outcome";

interface FlowNode {
  id: string;
  label: string;
  kind: NodeKind;
  color?: string;
  detail?: string;
}

interface FlowConnection {
  from: string;
  to: string;
  label?: string;
  side?: "left" | "right";
}

// --- Flow Data ---

const nodes: FlowNode[] = [
  {
    id: "start",
    label: "실행훅()",
    kind: "action",
    detail: "훅 이벤트가 트리거됨",
  },
  {
    id: "trusted",
    label: "작업 공간을 신뢰할 수 있나요?",
    kind: "decision",
  },
  {
    id: "skip",
    label: "즉시 반납",
    kind: "outcome",
    color: "#87867f",
    detail: "훅가 비활성화되었습니다.",
  },
  {
    id: "match",
    label: "매치훅 구성 규칙",
    kind: "action",
    detail: "이벤트 유형 + 패턴으로 필터링",
  },
  {
    id: "run",
    label: "일치하는 훅 실행",
    kind: "action",
    detail: "시간 초과가 있는 병렬 실행",
  },
  {
    id: "exit",
    label: "종료 코드 확인",
    kind: "decision",
  },
  {
    id: "success",
    label: "출구 0: 성공",
    kind: "outcome",
    color: "#22c55e",
    detail: "공구콜 진행",
  },
  {
    id: "block",
    label: "2번 출구: 차단",
    kind: "outcome",
    color: "#ef4444",
    detail: "도구 호출이 거부됨",
  },
  {
    id: "warn",
    label: "기타: 경고",
    kind: "outcome",
    color: "#eab308",
    detail: "기록됨, 통화가 진행됨",
  },
];

const connections: FlowConnection[] = [
  { from: "start", to: "trusted" },
  { from: "trusted", to: "skip", label: "아니요", side: "right" },
  { from: "trusted", to: "match", label: "예" },
  { from: "match", to: "run" },
  { from: "run", to: "exit" },
  { from: "exit", to: "success" },
  { from: "exit", to: "block" },
  { from: "exit", to: "warn" },
];

// --- SVG Arrow (Down) ---

function DownArrow({ color }: { color: string }) {
  return (
    <svg
      width="24"
      height="28"
      viewBox="0 0 24 28"
      fill="none"
      style={{ display: "block", margin: "0 auto" }}
    >
      <line
        x1="12"
        y1="2"
        x2="12"
        y2="22"
        stroke={color}
        strokeWidth="1.5"
      />
      <polyline
        points="7,18 12,25 17,18"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Side Arrow ---

function SideArrow({ color, direction }: { color: string; direction: "left" | "right" }) {
  return (
    <svg
      width="40"
      height="24"
      viewBox="0 0 40 24"
      fill="none"
      style={{
        display: "block",
        flexShrink: 0,
        transform: direction === "left" ? "scaleX(-1)" : undefined,
      }}
    >
      <line
        x1="4"
        y1="12"
        x2="32"
        y2="12"
        stroke={color}
        strokeWidth="1.5"
      />
      <polyline
        points="28,7 36,12 28,17"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Node Renderers ---

function ActionNode({
  node,
  colors,
  delay,
}: {
  node: FlowNode;
  colors: ReturnType<typeof getColors>;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      style={{
        padding: "12px 20px",
        borderRadius: 10,
        border: `1.5px solid ${colors.terracotta}44`,
        backgroundColor: colors.surface,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: colors.text,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.3,
        }}
      >
        {node.label}
      </div>
      {node.detail && (
        <div
          style={{
            fontSize: 11,
            color: colors.textMuted,
            marginTop: 3,
          }}
        >
          {node.detail}
        </div>
      )}
    </motion.div>
  );
}

function DecisionNode({
  node,
  colors,
  delay,
}: {
  node: FlowNode;
  colors: ReturnType<typeof getColors>;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.3 }}
      style={{
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          padding: "10px 24px",
          borderRadius: 10,
          border: `1.5px solid ${colors.terracotta}`,
          backgroundColor: `${colors.terracotta}11`,
          textAlign: "center",
          position: "relative",
        }}
      >
        {/* Diamond indicator */}
        <div
          style={{
            position: "absolute",
            top: -6,
            left: "50%",
            transform: "translateX(-50%) rotate(45deg)",
            width: 10,
            height: 10,
            backgroundColor: colors.terracotta,
            borderRadius: 2,
          }}
        />
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: colors.terracotta,
            lineHeight: 1.3,
          }}
        >
          {node.label}
        </div>
      </div>
    </motion.div>
  );
}

function OutcomeNode({
  node,
  colors,
  delay,
}: {
  node: FlowNode;
  colors: ReturnType<typeof getColors>;
  delay: number;
}) {
  const accent = node.color || colors.textMuted;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      style={{
        padding: "10px 16px",
        borderRadius: 8,
        border: `1.5px solid ${accent}44`,
        backgroundColor: `${accent}11`,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.3,
        }}
      >
        {node.label}
      </div>
      {node.detail && (
        <div
          style={{
            fontSize: 11,
            color: colors.textMuted,
            marginTop: 2,
          }}
        >
          {node.detail}
        </div>
      )}
    </motion.div>
  );
}

// --- Branch Label ---

function BranchLabel({
  label,
  colors,
}: {
  label: string;
  colors: ReturnType<typeof getColors>;
}) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: colors.textMuted,
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
        fontFamily: "var(--font-mono)",
      }}
    >
      {label}
    </span>
  );
}

// --- Main Component ---

export default function HookExecutionFlow({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();
  const colors = getColors(isDark);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        width: "100%",
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      {/* Title */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: colors.terracotta,
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
          marginBottom: 20,
          fontFamily: "var(--font-mono)",
        }}
      >
        훅 실행 흐름
      </motion.div>

      {/* Step 1: executeHooks */}
      <ActionNode node={nodes[0]} colors={colors} delay={0} />
      <DownArrow color={colors.border} />

      {/* Step 2: Trusted? Decision */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          width: "100%",
          justifyContent: "center",
        }}
      >
        <div style={{ flex: 1, maxWidth: 200 }} />
        <DecisionNode node={nodes[1]} colors={colors} delay={0.1} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            maxWidth: 200,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
            }}
          >
            <BranchLabel label="No" colors={colors} />
            <SideArrow color={colors.border} direction="right" />
          </div>
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            <OutcomeNode node={nodes[2]} colors={colors} delay={0.2} />
          </motion.div>
        </div>
      </div>

      {/* Yes branch arrow */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        <BranchLabel label="Yes" colors={colors} />
        <DownArrow color={colors.border} />
      </div>

      {/* Step 3: Match rules */}
      <ActionNode node={nodes[3]} colors={colors} delay={0.2} />
      <DownArrow color={colors.border} />

      {/* Step 4: Run hooks */}
      <ActionNode node={nodes[4]} colors={colors} delay={0.3} />
      <DownArrow color={colors.border} />

      {/* Step 5: Exit code decision */}
      <DecisionNode node={nodes[5]} colors={colors} delay={0.4} />

      {/* Three exit code outcomes */}
      <div style={{ height: 12 }} />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.35 }}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 12,
          width: "100%",
        }}
      >
        {/* Connecting lines from decision to outcomes */}
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "center" }}>
          <svg
            width="100%"
            height="24"
            viewBox="0 0 400 24"
            fill="none"
            preserveAspectRatio="xMidYMid meet"
            style={{ maxWidth: 400 }}
          >
            {/* Left branch */}
            <line x1="200" y1="0" x2="67" y2="18" stroke={colors.border} strokeWidth="1.5" />
            <polyline points="64,13 67,20 72,15" fill="none" stroke={colors.border} strokeWidth="1.5" strokeLinejoin="round" />
            {/* Center */}
            <line x1="200" y1="0" x2="200" y2="18" stroke={colors.border} strokeWidth="1.5" />
            <polyline points="196,14 200,21 204,14" fill="none" stroke={colors.border} strokeWidth="1.5" strokeLinejoin="round" />
            {/* Right branch */}
            <line x1="200" y1="0" x2="333" y2="18" stroke={colors.border} strokeWidth="1.5" />
            <polyline points="328,15 333,20 336,13" fill="none" stroke={colors.border} strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </div>
        <OutcomeNode node={nodes[6]} colors={colors} delay={0.55} />
        <OutcomeNode node={nodes[7]} colors={colors} delay={0.6} />
        <OutcomeNode node={nodes[8]} colors={colors} delay={0.65} />
      </motion.div>
    </div>
  );
}
