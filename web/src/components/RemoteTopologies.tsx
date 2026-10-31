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

// --- Types ---

interface FlowNode {
  id: string;
  label: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  direction?: "right" | "down" | "left";
}

interface Topology {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  accentLight: string;
  icon: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  layout: "horizontal" | "vertical-pair";
}

// --- Data ---

const topologies: Topology[] = [
  {
    id: "bridge-v1",
    title: "브리지 v1",
    subtitle: "설문조사 기반",
    accent: "#d97757",
    accentLight: "#d9775733",
    icon: "\u{1F310}",
    nodes: [
      { id: "cli", label: "로컬 CLI" },
      { id: "env-api", label: "환경 API" },
      { id: "web", label: "웹 인터페이스" },
    ],
    edges: [
      { from: "cli", to: "env-api", label: "등록" },
      { from: "env-api", to: "cli", label: "업무용 설문조사" },
      { from: "cli", to: "web", label: "WS 읽기/HTTP 쓰기" },
    ],
    layout: "horizontal",
  },
  {
    id: "bridge-v2",
    title: "브리지 v2",
    subtitle: "직접 세션",
    accent: "#60a5fa",
    accentLight: "#60a5fa33",
    icon: "\u{26A1}",
    nodes: [
      { id: "cli", label: "로컬 CLI" },
      { id: "session-api", label: "세션 API" },
      { id: "web", label: "웹 인터페이스" },
    ],
    edges: [
      { from: "cli", to: "session-api", label: "세션 생성" },
      { from: "cli", to: "web", label: "SSE 읽기/CCR 쓰기" },
    ],
    layout: "horizontal",
  },
  {
    id: "direct",
    title: "직접 연결",
    subtitle: "피어 투 피어",
    accent: "#4ade80",
    accentLight: "#4ade8033",
    icon: "\u{1F517}",
    nodes: [
      { id: "client", label: "원격 클라이언트" },
      { id: "server", label: "로컬 CLI 서버" },
    ],
    edges: [
      { from: "client", to: "server", label: "웹소켓(cc:// URL)" },
    ],
    layout: "horizontal",
  },
  {
    id: "upstream",
    title: "업스트림 프록시",
    subtitle: "관리형 인프라",
    accent: "#c084fc",
    accentLight: "#c084fc33",
    icon: "\u{2601}\u{FE0F}",
    nodes: [
      { id: "container", label: "CCR 컨테이너" },
      { id: "infra", label: "인류 인프라" },
      { id: "apis", label: "타사 API" },
    ],
    edges: [
      { from: "container", to: "infra", label: "WS 터널" },
      { from: "infra", to: "apis", label: "자격 증명 주입" },
    ],
    layout: "horizontal",
  },
];

// --- Arrow SVG ---

function Arrow({
  color,
  direction = "right",
}: {
  color: string;
  direction?: "right" | "down" | "left";
}) {
  if (direction === "down") {
    return (
      <svg
        width="24"
        height="32"
        viewBox="0 0 24 32"
        fill="none"
        style={{ display: "block", margin: "0 auto" }}
      >
        <line
          x1="12"
          y1="2"
          x2="12"
          y2="26"
          stroke={color}
          strokeWidth="1.5"
        />
        <polyline
          points="7,21 12,28 17,21"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="48"
      height="24"
      viewBox="0 0 48 24"
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
        x2="40"
        y2="12"
        stroke={color}
        strokeWidth="1.5"
      />
      <polyline
        points="35,7 42,12 35,17"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Node Box ---

function NodeBox({
  label,
  accent,
  accentLight,
  isDark,
  colors,
}: {
  label: string;
  accent: string;
  accentLight: string;
  isDark: boolean;
  colors: ReturnType<typeof getColors>;
}) {
  return (
    <div
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: `1.5px solid ${accent}`,
        backgroundColor: isDark ? accentLight : accentLight,
        color: colors.text,
        fontSize: 13,
        fontWeight: 500,
        textAlign: "center",
        lineHeight: 1.3,
        whiteSpace: "nowrap",
        minWidth: 90,
      }}
    >
      {label}
    </div>
  );
}

// --- Edge Label ---

function EdgeLabel({
  label,
  colors,
}: {
  label: string;
  colors: ReturnType<typeof getColors>;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        color: colors.textMuted,
        textAlign: "center",
        lineHeight: 1.2,
        maxWidth: 100,
        whiteSpace: "normal",
      }}
    >
      {label}
    </div>
  );
}

// --- Colors ---

function getColors(isDark: boolean) {
  return {
    bg: isDark ? "#1e1e1c" : "#ffffff",
    surface: isDark ? "#2a2a28" : "#f5f4ed",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#444" : "#c2c0b6",
  };
}

// --- Topology Card ---

function TopologyCard({
  topology,
  isDark,
  index,
}: {
  topology: Topology;
  isDark: boolean;
  index: number;
}) {
  const colors = getColors(isDark);
  const { accent, accentLight, nodes, edges } = topology;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08, duration: 0.35 }}
      style={{
        backgroundColor: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>{topology.icon}</span>
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: colors.text,
              lineHeight: 1.2,
            }}
          >
            {topology.title}
          </div>
          <div
            style={{
              fontSize: 12,
              color: accent,
              fontWeight: 500,
              lineHeight: 1.4,
            }}
          >
            {topology.subtitle}
          </div>
        </div>
      </div>

      {/* Flow Diagram */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flex: 1,
          justifyContent: "center",
        }}
      >
        {edges.map((edge, edgeIdx) => {
          const fromNode = nodes.find((n) => n.id === edge.from);
          const toNode = nodes.find((n) => n.id === edge.to);
          if (!fromNode || !toNode) return null;

          return (
            <div
              key={edgeIdx}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <NodeBox
                label={fromNode.label}
                accent={accent}
                accentLight={accentLight}
                isDark={isDark}
                colors={colors}
              />
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  flexShrink: 0,
                }}
              >
                <EdgeLabel label={edge.label} colors={colors} />
                <Arrow color={accent} direction={edge.direction || "right"} />
              </div>
              <NodeBox
                label={toNode.label}
                accent={accent}
                accentLight={accentLight}
                isDark={isDark}
                colors={colors}
              />
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

// --- Main Component ---

export default function RemoteTopologies({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();

  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        gap: 16,
        width: "100%",
      }}
    >
      {topologies.map((topology, i) => (
        <TopologyCard
          key={topology.id}
          topology={topology}
          isDark={isDark}
          index={i}
        />
      ))}
    </div>
  );
}
