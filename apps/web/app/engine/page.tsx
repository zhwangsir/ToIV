"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Icon, type IconName } from "@/components/ui/Icon";
import { getToken } from "@/lib/api";
import { ENGINE_DRAFT_KEY, consumeEngineDraft, type EngineDraft } from "@/lib/engine";

type Capability = {
  key: string;
  label: string;
  description: string;
  icon: IconName;
  href: string;
  external?: boolean;
  accent?: "default" | "muted" | "spot";
};

const CAPABILITIES: Capability[] = [
  {
    key: "image",
    label: "图像生成",
    description: "文生图 / 图生图",
    icon: "image",
    href: "/?view=create",
    accent: "spot",
  },
  {
    key: "video",
    label: "视频生成",
    description: "LTX / 图生视频",
    icon: "video",
    href: "/?view=video",
  },
  {
    key: "dramaStudio",
    label: "工作室",
    description: "剧本 → 分镜 → 成片",
    icon: "drama",
    href: "/?view=dramaStudio",
    accent: "spot",
  },
  {
    key: "canvas",
    label: "无限画布",
    description: "节点式工作流",
    icon: "canvas",
    href: "/?view=canvas",
  },
  {
    key: "dub",
    label: "AI 译制",
    description: "多语言配音",
    icon: "mic",
    href: "/?view=dub",
  },
  {
    key: "avatar",
    label: "数字人",
    description: "对话式数字人",
    icon: "phone",
    href: "/?view=avatartalk",
  },
  {
    key: "nsfw",
    label: "NSFW 专区",
    description: "R18 创作台",
    icon: "lock",
    href: "/nsfw",
    external: true,
  },
  {
    key: "library",
    label: "作品库",
    description: "浏览历史产出",
    icon: "library",
    href: "/?view=library",
  },
  {
    key: "models",
    label: "模型库",
    description: "管理模型与 LoRA",
    icon: "models",
    href: "/?view=models",
  },
];

function useAuthGuard() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!getToken()) {
      router.replace("/");
      return;
    }
    setChecking(false);
  }, [router]);

  return checking;
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const resolved = root.getAttribute("data-theme");
    setTheme(resolved === "dark" ? "dark" : "light");

    const observer = new MutationObserver(() => {
      const next = root.getAttribute("data-theme");
      setTheme(next === "dark" ? "dark" : "light");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    window.localStorage.setItem("toiv-theme", next);
    setTheme(next);
  };

  return { theme, toggle };
}

function QuickStart({ prompt, onPromptChange, onGo }: {
  prompt: string;
  onPromptChange: (v: string) => void;
  onGo: (cap: Capability) => void;
}) {
  const [mode, setMode] = useState<Capability["key"]>("image");

  const selected = useMemo(
    () => CAPABILITIES.find((c) => c.key === mode) ?? CAPABILITIES[0],
    [mode],
  );

  return (
    <div className="engine-quickstart">
      <div className="engine-quickstart-tabs">
        {CAPABILITIES.slice(0, 6).map((cap) => (
          <button
            key={cap.key}
            type="button"
            className={`engine-quickstart-tab ${mode === cap.key ? "active" : ""}`}
            onClick={() => setMode(cap.key)}
            aria-pressed={mode === cap.key}
          >
            <Icon name={cap.icon} size={14} />
            <span>{cap.label}</span>
          </button>
        ))}
      </div>
      <div className="engine-input-wrap">
        <input
          type="text"
          className="engine-input"
          placeholder={`描述你想创作的${selected.label}…`}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim()) onGo(selected);
          }}
        />
        <button
          type="button"
          className="engine-input-btn"
          disabled={!prompt.trim()}
          onClick={() => onGo(selected)}
        >
          <Icon name="sparkles" size={16} />
          <span>开始创作</span>
        </button>
      </div>

      <style jsx>{`
        .engine-quickstart {
          width: 100%;
          max-width: 760px;
          margin: 0 auto var(--space-10);
        }
        .engine-quickstart-tabs {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
          justify-content: center;
          margin-bottom: var(--space-3);
        }
        .engine-quickstart-tab {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border: 1px solid transparent;
          border-radius: var(--radius-full);
          background: transparent;
          color: var(--color-text-secondary);
          font-size: var(--text-sm);
          cursor: pointer;
          transition: all var(--duration-base) var(--ease-standard);
        }
        .engine-quickstart-tab:hover {
          background: var(--color-accent-soft);
          color: var(--color-text-primary);
        }
        .engine-quickstart-tab.active {
          background: var(--color-accent);
          color: var(--color-text-inverse);
        }
        .engine-input-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-xl);
          box-shadow: var(--shadow-md);
          transition: box-shadow var(--duration-base) var(--ease-standard);
        }
        .engine-input-wrap:focus-within {
          box-shadow: var(--shadow-lg), 0 0 0 1px var(--color-accent-line);
        }
        .engine-input {
          flex: 1;
          min-width: 0;
          padding: var(--space-3) var(--space-3);
          border: none;
          background: transparent;
          color: var(--color-text-primary);
          font-size: var(--text-md);
          outline: none;
        }
        .engine-input::placeholder {
          color: var(--color-text-tertiary);
        }
        .engine-input-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          border: none;
          border-radius: var(--radius-lg);
          background: var(--color-accent);
          color: var(--color-text-inverse);
          font-size: var(--text-sm);
          font-weight: 500;
          cursor: pointer;
          transition: background var(--duration-base) var(--ease-standard);
          flex-shrink: 0;
        }
        .engine-input-btn:hover:not(:disabled) {
          background: var(--color-accent-hover);
        }
        .engine-input-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        @media (max-width: 576px) {
          .engine-input-wrap {
            flex-direction: column;
            align-items: stretch;
            border-radius: var(--radius-lg);
          }
          .engine-input-btn {
            justify-content: center;
          }
        }
      `}</style>
    </div>
  );
}

export default function EnginePage() {
  const router = useRouter();
  const checking = useAuthGuard();
  const { theme, toggle } = useTheme();
  const [prompt, setPrompt] = useState("");

  // 登录后从 engine 返回时保留已输入的 prompt(避免返回后丢失)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prev = window.localStorage.getItem(ENGINE_DRAFT_KEY);
    if (!prev) return;
    try {
      const parsed = JSON.parse(prev) as Partial<EngineDraft>;
      if (typeof parsed.prompt === "string") setPrompt(parsed.prompt);
    } catch {
      /* ignore */
    }
  }, []);

  const go = (cap: Capability) => {
    if (typeof window === "undefined") return;
    if (prompt.trim()) {
      window.localStorage.setItem(ENGINE_DRAFT_KEY, JSON.stringify({ prompt: prompt.trim(), target: cap.key }));
    }
    if (cap.external) {
      window.location.href = cap.href;
    } else {
      router.push(cap.href);
    }
  };

  if (checking) {
    return (
      <div className="engine-shell loading">
        <div className="splash-orb" aria-hidden="true" />
        <style jsx>{`
          .engine-shell.loading {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="engine-shell">
      <header className="engine-header">
        <button type="button" className="engine-header-btn" onClick={() => router.push("/")} aria-label="返回首页">
          <Icon name="chevron-left" size={18} />
          <span className="engine-header-logo">ToIV</span>
        </button>
        <div className="engine-header-actions">
          <button type="button" className="engine-icon-btn" onClick={toggle} aria-label="切换主题">
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
        </div>
      </header>

      <main className="engine-main">
        <div className="engine-hero">
          <h1 className="engine-title">创作引擎</h1>
          <p className="engine-subtitle">统一入口，按需选择创作方式</p>
        </div>

        <QuickStart prompt={prompt} onPromptChange={setPrompt} onGo={go} />

        <section className="engine-grid-section" aria-label="创作能力">
          <div className="engine-grid">
            {CAPABILITIES.map((cap) => (
              <button
                key={cap.key}
                type="button"
                className={`engine-card ${cap.accent === "spot" ? "spot" : ""}`}
                onClick={() => go(cap)}
              >
                <div className="engine-card-icon">
                  <Icon name={cap.icon} size={22} />
                </div>
                <div className="engine-card-body">
                  <div className="engine-card-title">{cap.label}</div>
                  <div className="engine-card-desc">{cap.description}</div>
                </div>
                <Icon name="chevron-right" size={14} className="engine-card-arrow" />
              </button>
            ))}
          </div>
        </section>
      </main>

      <style jsx>{`
        .engine-shell {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          background: var(--color-bg-base);
          color: var(--color-text-primary);
        }
        .engine-header {
          position: sticky;
          top: 0;
          z-index: var(--z-sticky);
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: var(--topbar-h);
          padding: 0 var(--space-4);
          background: color-mix(in srgb, var(--color-bg-base) 90%, transparent);
          backdrop-filter: var(--backdrop-blur);
          border-bottom: 1px solid var(--color-border);
        }
        .engine-header-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border: none;
          background: transparent;
          color: var(--color-text-secondary);
          font-size: var(--text-sm);
          cursor: pointer;
          border-radius: var(--radius-md);
          transition: background var(--duration-base) var(--ease-standard);
        }
        .engine-header-btn:hover {
          background: var(--color-accent-soft);
          color: var(--color-text-primary);
        }
        .engine-header-logo {
          font-family: var(--font-display);
          font-weight: 600;
          color: var(--color-text-primary);
        }
        .engine-header-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .engine-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-surface);
          color: var(--color-text-secondary);
          cursor: pointer;
          transition: all var(--duration-base) var(--ease-standard);
        }
        .engine-icon-btn:hover {
          border-color: var(--color-accent-line);
          color: var(--color-text-primary);
        }
        .engine-main {
          flex: 1;
          padding: var(--space-8) var(--space-4) var(--space-12);
          overflow-y: auto;
        }
        .engine-hero {
          text-align: center;
          margin-bottom: var(--space-8);
        }
        .engine-title {
          margin: 0 0 var(--space-2);
          font-family: var(--font-display);
          font-size: clamp(var(--text-2xl), 5vw, 36px);
          font-weight: 600;
          letter-spacing: -0.03em;
        }
        .engine-subtitle {
          margin: 0;
          color: var(--color-text-secondary);
          font-size: var(--text-md);
        }
        .engine-grid-section {
          width: 100%;
          max-width: 960px;
          margin: 0 auto;
        }
        .engine-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-3);
        }
        .engine-card {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4);
          text-align: left;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          background: var(--color-bg-surface);
          color: var(--color-text-primary);
          cursor: pointer;
          transition: all var(--duration-base) var(--ease-standard);
          box-shadow: var(--shadow-sm);
        }
        .engine-card:hover {
          transform: translateY(-1px);
          border-color: var(--color-accent-line);
          box-shadow: var(--shadow-md);
        }
        .engine-card.spot .engine-card-icon {
          color: var(--color-accent);
          background: var(--color-accent-soft);
        }
        .engine-card-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          border-radius: var(--radius-md);
          background: var(--color-bg-subtle);
          color: var(--color-text-secondary);
        }
        .engine-card-body {
          flex: 1;
          min-width: 0;
        }
        .engine-card-title {
          font-weight: 500;
          font-size: var(--text-md);
          margin-bottom: 2px;
        }
        .engine-card-desc {
          color: var(--color-text-tertiary);
          font-size: var(--text-xs);
        }
        .engine-card-arrow {
          flex-shrink: 0;
          color: var(--color-text-tertiary);
          transition: transform var(--duration-base) var(--ease-standard);
        }
        .engine-card:hover .engine-card-arrow {
          transform: translateX(2px);
          color: var(--color-text-secondary);
        }
        @media (max-width: 576px) {
          .engine-grid {
            grid-template-columns: 1fr;
          }
          .engine-main {
            padding-top: var(--space-5);
          }
        }
      `}</style>
    </div>
  );
}
