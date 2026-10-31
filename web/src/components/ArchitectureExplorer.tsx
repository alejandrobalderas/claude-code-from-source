import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

// --- Data ---

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  description: string;
  href?: string;
  primary: boolean;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  label: string;
}

const nodes: GraphNode[] = [
  {
    id: "query-loop",
    label: "쿼리 루프",
    description:
      "모든 것을 구동하는 비동기 생성기입니다. 모델 출력을 스트리밍하고, 도구를 실행하고, 컨텍스트를 관리합니다.",
    href: "/ch05-agent-loop/",
    primary: true,
  },
  {
    id: "tool-system",
    label: "도구 시스템",
    description:
      "14단계 실행 파이프라인을 갖춘 40개 이상의 도구. 허가 시스템, 결과 예산 책정.",
    href: "/ch06-tools/",
    primary: true,
  },
  {
    id: "tasks",
    label: "작업",
    description:
      "하위 에이전트 및 백그라운드 작업. 상태 머신: 보류 중, 실행 중, 완료/실패.",
    href: "/ch10-coordination/",
    primary: true,
  },
  {
    id: "state-layer",
    label: "상태 레이어",
    description:
      "2계층: Bootstrap STATE(변경 가능한 싱글톤) + AppState(반응형 저장소)",
    href: "/ch03-state/",
    primary: true,
  },
  {
    id: "hooks",
    label: "훅",
    description:
      "27개의 라이프사이클 이벤트. 시작 시 구성이 고정되었습니다. 도구를 차단하고, 결과를 수정하고, 강제로 계속할 수 있습니다.",
    href: "/ch12-extensibility/",
    primary: true,
  },
  {
    id: "memory",
    label: "메모리",
    description:
      "LLM 기반 리콜을 통한 파일 기반. 4가지 유형: 사용자, 피드백, 프로젝트, 참조.",
    href: "/ch11-memory/",
    primary: true,
  },
  {
    id: "user",
    label: "사용자",
    description: "CLI와 상호 작용하는 개발자.",
    primary: false,
  },
  {
    id: "repl",
    label: "REPL",
    description: "터미널 인터페이스. 입력, 렌더링, 권한을 처리합니다.",
    href: "/ch13-terminal-ui/",
    primary: false,
  },
];

const links: GraphLink[] = [
  { source: "user", target: "repl", label: "입력" },
  { source: "repl", target: "query-loop", label: "프롬프트" },
  { source: "query-loop", target: "tool-system", label: "도구 호출" },
  { source: "tool-system", target: "query-loop", label: "도구 결과" },
  { source: "query-loop", target: "tasks", label: "산란" },
  { source: "tasks", target: "query-loop", label: "자신의 쿼리 루프" },
  { source: "tasks", target: "repl", label: "풍선 권한" },
  { source: "query-loop", target: "hooks", label: "화재 사건" },
  { source: "hooks", target: "tool-system", label: "PreToolUse / PostToolUse" },
  { source: "hooks", target: "query-loop", label: "훅 중지" },
  { source: "query-loop", target: "state-layer", label: "읽기/쓰기" },
  { source: "state-layer", target: "query-loop", label: "부트스트랩 싱글톤" },
  { source: "state-layer", target: "repl", label: "반응 저장소" },
  {
    source: "memory",
    target: "query-loop",
    label: "세션 시작 시 주입",
  },
];

// --- Component ---

interface Props {
  className?: string;
}

export default function ArchitectureExplorer({ className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(
    null,
  );
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    node: GraphNode;
  } | null>(null);
  const [isDark, setIsDark] = useState(false);

  // Detect dark mode
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    window.addEventListener("theme-changed", check);
    // Also listen for class changes (MutationObserver)
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

  const colors = {
    nodePrimary: "#d97757",
    nodeSecondary: "#87867f",
    edge: isDark ? "rgba(194,192,182,0.3)" : "rgba(194,192,182,0.6)",
    edgeHighlight: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    tooltipBg: isDark ? "#1e1e1c" : "#ffffff",
    tooltipBorder: isDark ? "#333" : "#c2c0b6",
  };

  const getConnectedLinks = useCallback(
    (nodeId: string) => {
      return links.filter(
        (l) =>
          (typeof l.source === "string" ? l.source : (l.source as GraphNode).id) === nodeId ||
          (typeof l.target === "string" ? l.target : (l.target as GraphNode).id) === nodeId,
      );
    },
    [],
  );

  const getConnectedNodeIds = useCallback(
    (nodeId: string) => {
      const connected = new Set<string>();
      connected.add(nodeId);
      for (const l of links) {
        const sid = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
        if (sid === nodeId) connected.add(tid);
        if (tid === nodeId) connected.add(sid);
      }
      return connected;
    },
    [],
  );

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = Math.max(500, Math.min(600, width * 0.65));

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`);

    // Clear previous
    svg.selectAll("*").remove();

    // Defs for arrow markers
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", colors.edge);

    defs
      .append("marker")
      .attr("id", "arrow-highlight")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", colors.edgeHighlight);

    // Clone data for simulation
    const simNodes: GraphNode[] = nodes.map((d) => ({ ...d }));
    const simLinks: GraphLink[] = links.map((d) => ({ ...d }));

    // Force simulation
    const isMobile = width < 640;
    const nodeRadius = isMobile ? 20 : 26;
    const labelOffset = isMobile ? 28 : 34;

    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphLink>(simLinks)
          .id((d) => d.id)
          .distance(isMobile ? 100 : 140),
      )
      .force("charge", d3.forceManyBody().strength(isMobile ? -400 : -600))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(nodeRadius + 20))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05));

    simulationRef.current = simulation;

    const g = svg.append("g");

    // Links
    const link = g
      .append("g")
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("class", "graph-link")
      .attr("stroke", colors.edge)
      .attr("stroke-width", 1.5)
      .attr("marker-end", "url(#arrow)");

    // Link labels
    const linkLabel = g
      .append("g")
      .selectAll("text")
      .data(simLinks)
      .join("text")
      .attr("class", "graph-link-label")
      .attr("text-anchor", "middle")
      .attr("dy", -6)
      .attr("fill", colors.textSecondary)
      .attr("font-size", isMobile ? "8px" : "10px")
      .attr("font-family", "var(--font-mono)")
      .attr("opacity", 0)
      .text((d) => d.label);

    // Node groups
    const node = g
      .append("g")
      .selectAll<SVGGElement, GraphNode>("g")
      .data(simNodes)
      .join("g")
      .attr("class", "graph-node")
      .style("cursor", (d) => (d.href ? "pointer" : "default"))
      .call(
        d3
          .drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    // Node circles
    node
      .append("circle")
      .attr("r", (d) => (d.primary ? nodeRadius : nodeRadius * 0.7))
      .attr("fill", (d) => (d.primary ? colors.nodePrimary : colors.nodeSecondary))
      .attr("opacity", 0)
      .transition()
      .duration(800)
      .delay((_, i) => i * 100)
      .attr("opacity", 1);

    // Node labels
    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (d.primary ? labelOffset : labelOffset * 0.75))
      .attr("fill", colors.text)
      .attr("font-size", isMobile ? "10px" : "12px")
      .attr("font-weight", (d) => (d.primary ? "600" : "400"))
      .attr("font-family", "var(--font-serif)")
      .text((d) => d.label);

    // Node icon letters (abbreviated)
    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "white")
      .attr("font-size", (d) => (d.primary ? (isMobile ? "12px" : "14px") : (isMobile ? "10px" : "12px")))
      .attr("font-weight", "700")
      .attr("font-family", "var(--font-mono)")
      .text((d) => {
        const abbrevMap: Record<string, string> = {
          "query-loop": "QL",
          "tool-system": "TS",
          tasks: "TK",
          "state-layer": "SL",
          hooks: "HK",
          memory: "MM",
          user: "U",
          repl: "R",
        };
        return abbrevMap[d.id] || d.label[0];
      });

    // Hover interactions
    node
      .on("mouseenter", (event, d) => {
        setHoveredNode(d.id);
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip({
          x: event.clientX - svgRect.left,
          y: event.clientY - svgRect.top - 10,
          node: d,
        });

        const connected = getConnectedNodeIds(d.id);

        // Dim non-connected nodes
        node.select("circle").transition().duration(200)
          .attr("opacity", (n: unknown) => connected.has((n as GraphNode).id) ? 1 : 0.2);
        node.selectAll("text").transition().duration(200)
          .attr("opacity", (n: unknown) => connected.has((n as GraphNode).id) ? 1 : 0.2);

        // Highlight connected links
        link.transition().duration(200)
          .attr("stroke", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id
              ? colors.edgeHighlight
              : colors.edge;
          })
          .attr("stroke-width", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 2.5 : 1;
          })
          .attr("opacity", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 1 : 0.15;
          })
          .attr("marker-end", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id
              ? "url(#arrow-highlight)"
              : "url(#arrow)";
          });

        // Show connected link labels
        linkLabel.transition().duration(200)
          .attr("opacity", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 1 : 0;
          });
      })
      .on("mousemove", (event) => {
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip((prev) =>
          prev
            ? {
                ...prev,
                x: event.clientX - svgRect.left,
                y: event.clientY - svgRect.top - 10,
              }
            : null,
        );
      })
      .on("mouseleave", () => {
        setHoveredNode(null);
        setTooltip(null);

        // Reset
        node.select("circle").transition().duration(200).attr("opacity", 1);
        node.selectAll("text").transition().duration(200).attr("opacity", 1);
        link
          .transition()
          .duration(200)
          .attr("stroke", colors.edge)
          .attr("stroke-width", 1.5)
          .attr("opacity", 1)
          .attr("marker-end", "url(#arrow)");
        linkLabel.transition().duration(200).attr("opacity", 0);
      })
      .on("click", (_, d) => {
        if (d.href) {
          const rawBase = (import.meta as Record<string, unknown>).env && typeof (import.meta as Record<string, Record<string, unknown>>).env.BASE_URL === 'string'
            ? (import.meta as Record<string, Record<string, string>>).env.BASE_URL
            : '/';
          const base = rawBase.endsWith("/") ? rawBase : rawBase + "/";
          window.location.href = base + d.href.replace(/^\//, "");
        }
      });

    // Tick
    simulation.on("tick", () => {
      // Constrain nodes within bounds
      for (const d of simNodes) {
        d.x = Math.max(nodeRadius + 10, Math.min(width - nodeRadius - 10, d.x!));
        d.y = Math.max(nodeRadius + 10, Math.min(height - nodeRadius - 10, d.y!));
      }

      link
        .attr("x1", (d) => (d.source as GraphNode).x!)
        .attr("y1", (d) => (d.source as GraphNode).y!)
        .attr("x2", (d) => (d.target as GraphNode).x!)
        .attr("y2", (d) => (d.target as GraphNode).y!);

      linkLabel
        .attr("x", (d) => ((d.source as GraphNode).x! + (d.target as GraphNode).x!) / 2)
        .attr("y", (d) => ((d.source as GraphNode).y! + (d.target as GraphNode).y!) / 2);

      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // Resize handler
    const handleResize = () => {
      const newRect = container.getBoundingClientRect();
      const newWidth = newRect.width;
      const newHeight = Math.max(500, Math.min(600, newWidth * 0.65));
      svg.attr("width", newWidth).attr("height", newHeight).attr("viewBox", `0 0 ${newWidth} ${newHeight}`);
      simulation.force("center", d3.forceCenter(newWidth / 2, newHeight / 2));
      simulation.force("x", d3.forceX(newWidth / 2).strength(0.05));
      simulation.force("y", d3.forceY(newHeight / 2).strength(0.05));
      simulation.alpha(0.3).restart();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      simulation.stop();
      window.removeEventListener("resize", handleResize);
    };
  }, [isDark, colors.edge, colors.edgeHighlight, colors.nodePrimary, colors.nodeSecondary, colors.text, colors.textSecondary, getConnectedNodeIds]);

  return (
    <div ref={containerRef} className={className} style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        style={{
          width: "100%",
          minHeight: 500,
          overflow: "visible",
        }}
      />
      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
            background: colors.tooltipBg,
            border: `1px solid ${colors.tooltipBorder}`,
            borderRadius: 8,
            padding: "10px 14px",
            maxWidth: 240,
            pointerEvents: "none",
            zIndex: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: colors.text,
              marginBottom: 4,
              fontFamily: "var(--font-serif)",
            }}
          >
            {tooltip.node.label}
          </div>
          <div
            style={{
              fontSize: 12,
              color: colors.textSecondary,
              lineHeight: 1.4,
              fontFamily: "var(--font-serif)",
            }}
          >
            {tooltip.node.description}
          </div>
          {tooltip.node.href && (
            <div
              style={{
                fontSize: 11,
                color: "#d97757",
                marginTop: 6,
                fontFamily: "var(--font-mono)",
              }}
            >
              장을 읽으려면 클릭하세요
            </div>
          )}
        </div>
      )}
      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          marginTop: 8,
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-serif)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#d97757",
              display: "inline-block",
            }}
          />
          핵심 추상화
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#87867f",
              display: "inline-block",
            }}
          />
          인터페이스
        </span>
        <span>탐색하려면 노드를 드래그하세요. 자세한 내용을 보려면 마우스를 가져가세요. 읽으려면 클릭하세요.</span>
      </div>
    </div>
  );
}
