import { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

interface Preset {
  label: string;
  prefixTokens: number;
  uniqueTokens: number;
  children: number;
}

const presets: Preset[] = [
  { label: "코드 검토(에이전트 3명)", prefixTokens: 60000, uniqueTokens: 8000, children: 3 },
  { label: "대규모 리팩터링(에이전트 10개)", prefixTokens: 100000, uniqueTokens: 5000, children: 10 },
  { label: "테스트 스위트(에이전트 15개)", prefixTokens: 80000, uniqueTokens: 3000, children: 15 },
];

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

function useAnimatedNumber(value: number, duration = 300) {
  const [display, setDisplay] = useState(value);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef({ value: value, time: 0 });

  useEffect(() => {
    const start = display;
    const startTime = performance.now();
    startRef.current = { value: start, time: startTime };

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      // Ease out quad
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(start + (value - start) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  return display;
}

// --- Component ---

interface Props {
  className?: string;
}

export default function PromptCacheCalculator({ className }: Props) {
  const isDark = useDarkMode();

  const [prefixTokens, setPrefixTokens] = useState(80000);
  const [uniqueTokens, setUniqueTokens] = useState(5000);
  const [children, setChildren] = useState(5);
  const [inputPrice, setInputPrice] = useState(3);
  const [cachePrice, setCachePrice] = useState(0.3);

  const colors = {
    terracotta: "#d97757",
    muted: "#87867f",
    savings: "#22c55e",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    bgCard: isDark ? "#2a2a28" : "#f8f7f2",
    border: isDark ? "#333" : "#c2c0b6",
    sliderTrack: isDark ? "#333" : "#e0dfd8",
  };

  const calc = useMemo(() => {
    const perMillion = 1_000_000;
    const totalPerChild = prefixTokens + uniqueTokens;

    // Without cache: every child pays full price for everything
    const withoutCache = children * totalPerChild * (inputPrice / perMillion);

    // With cache: first child pays full price for prefix, rest get cache discount
    const firstChildCost = totalPerChild * (inputPrice / perMillion);
    const cachedChildCost =
      prefixTokens * (cachePrice / perMillion) +
      uniqueTokens * (inputPrice / perMillion);
    const withCache =
      children > 0
        ? firstChildCost + Math.max(0, children - 1) * cachedChildCost
        : 0;

    const savingsDollars = withoutCache - withCache;
    const savingsPercent =
      withoutCache > 0 ? (savingsDollars / withoutCache) * 100 : 0;

    return { withoutCache, withCache, savingsDollars, savingsPercent };
  }, [prefixTokens, uniqueTokens, children, inputPrice, cachePrice]);

  const animWithout = useAnimatedNumber(calc.withoutCache);
  const animWith = useAnimatedNumber(calc.withCache);
  const animSavings = useAnimatedNumber(calc.savingsDollars);
  const animPercent = useAnimatedNumber(calc.savingsPercent);

  const formatDollars = (n: number) => {
    if (n < 0.01 && n > 0) return "<$0.01";
    return `$${n.toFixed(2)}`;
  };

  const applyPreset = (preset: Preset) => {
    setPrefixTokens(preset.prefixTokens);
    setUniqueTokens(preset.uniqueTokens);
    setChildren(preset.children);
  };

  // Bar chart proportions
  const maxCost = Math.max(calc.withoutCache, calc.withCache, 0.01);

  const sliderStyle: React.CSSProperties = {
    width: "100%",
    accentColor: colors.terracotta,
    cursor: "pointer",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: colors.text,
    fontFamily: "var(--font-serif)",
    marginBottom: 4,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  };

  const valueStyle: React.CSSProperties = {
    fontSize: 12,
    color: colors.terracotta,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  };

  const sliderGroupStyle: React.CSSProperties = {
    marginBottom: 16,
  };

  return (
    <div
      className={className}
      style={{ fontFamily: "var(--font-serif)" }}
    >
      {/* Presets */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 16,
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            alignSelf: "center",
            fontFamily: "var(--font-mono)",
          }}
        >
          사전 설정:
        </span>
        {presets.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset)}
            style={{
              background: "transparent",
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
              color: colors.textSecondary,
              fontFamily: "var(--font-serif)",
              cursor: "pointer",
              transition: "border-color 0.2s, color 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = colors.terracotta;
              e.currentTarget.style.color = colors.terracotta;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = colors.border;
              e.currentTarget.style.color = colors.textSecondary;
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Main layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 20,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 20,
        }}
      >
        {/* Left: Sliders */}
        <div
          style={{
            minWidth: 0,
          }}
        >
          <div style={sliderGroupStyle}>
            <div style={labelStyle}>
              <span>공유 접두사 크기</span>
              <span style={valueStyle}>
                {(prefixTokens / 1000).toFixed(0)}K토큰
              </span>
            </div>
            <input
              type="range"
              min={10000}
              max={200000}
              step={5000}
              value={prefixTokens}
              onChange={(e) => setPrefixTokens(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>

          <div style={sliderGroupStyle}>
            <div style={labelStyle}>
              <span>자녀별 고유 토큰</span>
              <span style={valueStyle}>
                {(uniqueTokens / 1000).toFixed(0)}K토큰
              </span>
            </div>
            <input
              type="range"
              min={1000}
              max={20000}
              step={1000}
              value={uniqueTokens}
              onChange={(e) => setUniqueTokens(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>

          <div style={sliderGroupStyle}>
            <div style={labelStyle}>
              <span>자녀 수</span>
              <span style={valueStyle}>{children}</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>

          <div style={sliderGroupStyle}>
            <div style={labelStyle}>
              <span>입력 토큰 가격</span>
              <span style={valueStyle}>${inputPrice}/1M</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={15}
              step={0.5}
              value={inputPrice}
              onChange={(e) => setInputPrice(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>

          <div style={sliderGroupStyle}>
            <div style={labelStyle}>
              <span>캐시 적중 가격</span>
              <span style={valueStyle}>${cachePrice}/1M</span>
            </div>
            <input
              type="range"
              min={0.05}
              max={5}
              step={0.05}
              value={cachePrice}
              onChange={(e) => setCachePrice(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>
        </div>

        {/* Right: Results */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Cost comparison bars */}
          <div>
            <div
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                fontFamily: "var(--font-mono)",
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              비용 비교
            </div>

            {/* Without cache bar */}
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  marginBottom: 4,
                  color: colors.textSecondary,
                }}
              >
                <span>캐시 없음</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                  {formatDollars(animWithout)}
                </span>
              </div>
              <div
                style={{
                  height: 24,
                  background: colors.sliderTrack,
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <motion.div
                  style={{
                    height: "100%",
                    background: colors.muted,
                    borderRadius: 4,
                  }}
                  animate={{
                    width: `${(calc.withoutCache / maxCost) * 100}%`,
                  }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                />
              </div>
            </div>

            {/* With cache bar */}
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  marginBottom: 4,
                  color: colors.text,
                }}
              >
                <span>캐시 공유 사용</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: colors.terracotta,
                  }}
                >
                  {formatDollars(animWith)}
                </span>
              </div>
              <div
                style={{
                  height: 24,
                  background: colors.sliderTrack,
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <motion.div
                  style={{
                    height: "100%",
                    background: colors.terracotta,
                    borderRadius: 4,
                  }}
                  animate={{
                    width: `${(calc.withCache / maxCost) * 100}%`,
                  }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                />
              </div>
            </div>
          </div>

          {/* Savings highlight */}
          <div
            style={{
              background: isDark
                ? "rgba(34,197,94,0.1)"
                : "rgba(34,197,94,0.06)",
              border: `1px solid ${isDark ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.2)"}`,
              borderRadius: 8,
              padding: "14px 16px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: colors.savings,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.1,
              }}
            >
              {animPercent.toFixed(0)}%
            </div>
            <div
              style={{
                fontSize: 13,
                color: colors.savings,
                marginTop: 2,
              }}
            >
              저장됨({formatDollars(animSavings)})
            </div>
          </div>

          {/* Breakdown */}
          <div
            style={{
              background: colors.bgCard,
              borderRadius: 6,
              padding: "12px 14px",
              fontSize: 12,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.8,
            }}
          >
            <div>
              <span style={{ opacity: 0.7 }}>캐시 없음:</span>{" "}
              {children} x ({(prefixTokens / 1000).toFixed(0)}K + {(uniqueTokens / 1000).toFixed(0)}K) x ${inputPrice}/1M
            </div>
            <div>
              <span style={{ opacity: 0.7 }}>캐시됨:</span>{" "}
              전체 1개 + {Math.max(0, children - 1)} 캐시된 접두사 + {children} 독특한
            </div>
            <div style={{ marginTop: 6, color: colors.text, fontSize: 11 }}>
              {children <= 1
                ? "캐시 절감 효과를 보려면 하위 항목을 더 추가하세요."
                : "캐시 공유는 N >= 2명의 자녀에게 효과적입니다."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
