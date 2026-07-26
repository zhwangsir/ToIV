"use client";

import { useEffect, useState } from "react";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface ScriptSectionProps {
  project: UseDramaProjectReturn;
}

/**
 * Film Atelier · 剧本区(工作流第 1 步)。
 * 剧本查看/编辑(patchProject)+ AI 拆分镜 + 9/25 宫格分镜,
 * 宫格结果(拼贴大图 + 分镜清单)就地展示;已有分镜时默认折叠。
 */
export function ScriptSection({ project }: ScriptSectionProps) {
  const {
    current,
    shots,
    patchProject,
    storyboard,
    storyboarding,
    showGridPicker,
    setShowGridPicker,
    gridBusy,
    gridStoryboard,
    gridImage,
    gridShots,
    gridError,
    clearGridResult,
    setRefPreview,
  } = project;

  const { show: showToast } = useToast();

  // 已有分镜后默认折叠,让位故事板
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (shots.length > 0) setOpen(false);
  }, [shots.length]);

  // 剧本编辑
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [numShots, setNumShots] = useState(6);

  if (!current) return null;

  const startEdit = () => {
    setDraft(current.script ?? "");
    setEditing(true);
  };
  const saveScript = () => {
    if (saving) return;
    setSaving(true);
    patchProject({ script: draft })
      .then(() => {
        setEditing(false);
        showToast("success", "剧本已保存");
      })
      .catch((err) =>
        showToast("error", err instanceof Error ? err.message : "保存剧本失败"),
      )
      .finally(() => setSaving(false));
  };

  const scriptLen = (current.script ?? "").length;

  return (
    <section className="fa-sec">
      <button
        type="button"
        className="fa-sec-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="fa-sec-idx">01</span>
        <span className="fa-sec-title">剧本</span>
        <span className="fa-sec-tag">SCRIPT · {scriptLen} 字</span>
        <span className="fa-sec-spacer" />
        {!open && (
          <span className="fa-sec-peek">
            {(current.script ?? "").slice(0, 36) || "尚未填写剧本"}…
          </span>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={13} />
      </button>

      {open && (
        <div className="fa-sec-body">
          {editing ? (
            <>
              <textarea
                className="fa-script-editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                placeholder="在此粘贴/编写剧本全文…"
              />
              <div className="fa-row">
                <button
                  type="button"
                  className="fa-btn fa-btn-sm"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="fa-btn fa-btn-amber fa-btn-sm"
                  onClick={saveScript}
                  disabled={saving}
                >
                  {saving ? (
                    <Icon name="loading" size={12} className="fa-spin" />
                  ) : (
                    <Icon name="check" size={12} />
                  )}
                  保存剧本
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className="fa-script-pre">
                {current.script || "尚未填写剧本 · 点右上角「编辑」开始"}
              </pre>
              <div className="fa-row">
                <button
                  type="button"
                  className="fa-btn fa-btn-sm"
                  onClick={startEdit}
                >
                  <Icon name="create" size={12} />
                  编辑
                </button>
                <span className="fa-row-divider" />
                <label className="fa-num">
                  <span>镜头数</span>
                  <input
                    type="number"
                    min={1}
                    max={48}
                    value={numShots}
                    onChange={(e) =>
                      setNumShots(
                        Math.max(1, Math.min(48, Number(e.target.value) || 6)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="fa-btn fa-btn-amber fa-btn-sm"
                  onClick={() => void storyboard(numShots)}
                  disabled={storyboarding || !current.script}
                  title={
                    current.script
                      ? "LLM 拆解剧本为分镜(场景/运镜/台词/时长)"
                      : "先填写剧本"
                  }
                >
                  {storyboarding ? (
                    <Icon name="loading" size={12} className="fa-spin" />
                  ) : (
                    <Icon name="film" size={12} />
                  )}
                  {storyboarding
                    ? "拆解中…"
                    : shots.length > 0
                      ? "重新拆解"
                      : "AI 拆解剧本"}
                </button>

                {/* 宫格分镜 */}
                <div className="fa-grid-bar">
                  <button
                    type="button"
                    className="fa-btn fa-btn-sm"
                    onClick={() => setShowGridPicker((v) => !v)}
                    disabled={gridBusy || !current.script}
                    title="一次性产出 9/25 张分镜并拼成宫格图"
                  >
                    {gridBusy ? (
                      <Icon name="loading" size={12} className="fa-spin" />
                    ) : (
                      <Icon name="grid" size={12} />
                    )}
                    宫格分镜
                  </button>
                  {showGridPicker && !gridBusy && (
                    <div className="fa-grid-picker" role="menu">
                      <button
                        type="button"
                        className="fa-grid-pick"
                        onClick={() => void gridStoryboard(9)}
                      >
                        <Icon name="grid" size={13} />
                        <span>
                          <strong>9 宫格</strong>
                          <em>3×3 · 9 镜速览</em>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="fa-grid-pick"
                        onClick={() => void gridStoryboard(25)}
                      >
                        <Icon name="grid" size={13} />
                        <span>
                          <strong>25 宫格</strong>
                          <em>5×5 · 25 镜全貌</em>
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* 宫格结果 */}
          {(gridBusy || gridImage || gridError) && (
            <div className="fa-grid-result">
              <div className="fa-grid-result-head">
                <Icon name="grid" size={12} />
                <span>宫格分镜</span>
                {gridShots.length > 0 && (
                  <span className="fa-grid-count">{gridShots.length}</span>
                )}
                <span className="fa-sec-spacer" />
                {gridImage && !gridBusy && (
                  <a
                    className="fa-btn fa-btn-sm"
                    href={imageUrl(gridImage)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="eye" size={11} />
                    大图
                  </a>
                )}
                {!gridBusy && (gridImage || gridError) && (
                  <button
                    type="button"
                    className="fa-icon-btn"
                    onClick={clearGridResult}
                    title="收起宫格结果"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              {gridError && <div className="fa-error-line">{gridError}</div>}
              {gridBusy && (
                <div className="fa-grid-loading">
                  <Icon name="loading" size={18} className="fa-spin" />
                  <span>正在生成宫格分镜,稍候…</span>
                </div>
              )}
              {!gridBusy && gridImage && (
                <img
                  className="fa-grid-img"
                  src={imageUrl(gridImage)}
                  alt="宫格分镜图"
                  onClick={() =>
                    setRefPreview({ url: gridImage, label: "宫格分镜图" })
                  }
                />
              )}
              {!gridBusy && gridShots.length > 0 && (
                <ul className="fa-grid-shots">
                  {gridShots.map((s, i) => (
                    <li key={s.id ?? i}>
                      <span className="fa-grid-shot-idx">
                        {String(s.idx).padStart(2, "0")}
                      </span>
                      <div className="fa-grid-shot-body">
                        <div className="fa-grid-shot-scene" title={s.scene}>
                          {s.scene || `分镜 ${s.idx}`}
                        </div>
                        {s.prompt && (
                          <p className="fa-grid-shot-prompt">
                            {s.prompt.slice(0, 46)}
                            {s.prompt.length > 46 ? "…" : ""}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .fa-sec {
          background: var(--fa-card);
          border: 1px solid var(--fa-line);
          border-radius: 10px;
          overflow: visible;
        }
        .fa-sec-head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          background: transparent;
          border: none;
          color: var(--fa-ink);
          font-family: inherit;
          cursor: pointer;
          text-align: left;
        }
        .fa-sec-idx {
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--fa-amber);
          border: 1px solid var(--fa-amber-line);
          border-radius: 4px;
          padding: 2px 5px;
        }
        .fa-sec-title {
          font-family: var(--fa-serif);
          font-size: 14px;
          font-weight: 600;
        }
        .fa-sec-tag {
          font-family: var(--fa-mono);
          font-size: 9px;
          letter-spacing: 0.12em;
          color: var(--fa-ink3);
        }
        .fa-sec-spacer {
          flex: 1;
        }
        .fa-sec-peek {
          max-width: 320px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          color: var(--fa-ink3);
        }
        .fa-sec-body {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 0 14px 13px;
          border-top: 1px solid var(--fa-line);
          padding-top: 12px;
        }
        .fa-script-pre {
          margin: 0;
          padding: 10px 12px;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 8px;
          font-family: var(--fa-mono);
          font-size: 11.5px;
          line-height: 1.7;
          color: var(--fa-ink2);
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 220px;
          overflow: auto;
        }
        .fa-script-editor {
          width: 100%;
          padding: 10px 12px;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-amber-line);
          border-radius: 8px;
          color: var(--fa-ink);
          font-family: var(--fa-mono);
          font-size: 11.5px;
          line-height: 1.7;
          resize: vertical;
          min-height: 140px;
        }
        .fa-script-editor:focus {
          outline: none;
          border-color: var(--fa-amber);
        }
        .fa-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .fa-row-divider {
          width: 1px;
          height: 16px;
          background: var(--fa-line-hi);
        }
        .fa-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 11.5px;
          font-family: inherit;
          background: var(--fa-hi);
          color: var(--fa-ink2);
          border: 1px solid var(--fa-line-hi);
          cursor: pointer;
          text-decoration: none;
          transition: all 0.2s ease;
        }
        .fa-btn:hover:not(:disabled) {
          color: var(--fa-ink);
          border-color: var(--fa-ink3);
        }
        .fa-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .fa-btn-amber {
          background: var(--fa-amber-soft);
          color: var(--fa-amber-hi);
          border-color: var(--fa-amber-line);
        }
        .fa-btn-amber:hover:not(:disabled) {
          background: var(--fa-amber);
          color: #171310;
          border-color: var(--fa-amber);
        }
        .fa-btn-sm {
          padding: 5px 10px;
          font-size: 11px;
        }
        .fa-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          padding: 0;
          background: transparent;
          border: 1px solid var(--fa-line-hi);
          border-radius: 5px;
          color: var(--fa-ink3);
          cursor: pointer;
        }
        .fa-icon-btn:hover {
          color: var(--fa-ink);
          border-color: var(--fa-ink3);
        }
        .fa-num {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 10.5px;
          color: var(--fa-ink3);
          font-family: var(--fa-mono);
        }
        .fa-num input {
          width: 52px;
          padding: 4px 6px;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line-hi);
          border-radius: 5px;
          color: var(--fa-ink);
          font-size: 11px;
          font-family: var(--fa-mono);
        }
        .fa-num input:focus {
          outline: none;
          border-color: var(--fa-amber);
        }
        .fa-grid-bar {
          position: relative;
        }
        .fa-grid-picker {
          position: absolute;
          top: calc(100% + 5px);
          left: 0;
          z-index: 30;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 6px;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line-hi);
          border-radius: 8px;
          box-shadow: 0 14px 34px -12px rgba(0, 0, 0, 0.7);
          min-width: 180px;
        }
        .fa-grid-pick {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 7px 9px;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 6px;
          color: var(--fa-ink);
          text-align: left;
          cursor: pointer;
          font-family: inherit;
        }
        .fa-grid-pick:hover {
          background: var(--fa-amber-soft);
          border-color: var(--fa-amber-line);
        }
        .fa-grid-pick :global(svg) {
          color: var(--fa-amber);
          flex-shrink: 0;
        }
        .fa-grid-pick span {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .fa-grid-pick strong {
          font-size: 12px;
          font-weight: 600;
        }
        .fa-grid-pick em {
          font-size: 10px;
          color: var(--fa-ink3);
          font-style: normal;
          font-family: var(--fa-mono);
        }
        .fa-grid-result {
          display: flex;
          flex-direction: column;
          gap: 9px;
          padding: 10px 12px;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 8px;
        }
        .fa-grid-result-head {
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 11.5px;
          font-weight: 600;
          color: var(--fa-ink);
        }
        .fa-grid-result-head :global(svg) {
          color: var(--fa-amber);
        }
        .fa-grid-count {
          font-family: var(--fa-mono);
          font-size: 10px;
          color: var(--fa-ink3);
          background: var(--fa-hi);
          border-radius: 10px;
          padding: 1px 7px;
        }
        .fa-error-line {
          padding: 7px 10px;
          background: rgba(194, 94, 94, 0.12);
          border: 1px solid var(--fa-red);
          border-radius: 6px;
          color: var(--fa-red);
          font-size: 11px;
        }
        .fa-grid-loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px;
          color: var(--fa-amber);
          font-size: 12px;
        }
        .fa-grid-img {
          width: 100%;
          border-radius: 6px;
          border: 1px solid var(--fa-line-hi);
          cursor: zoom-in;
          display: block;
        }
        .fa-grid-shots {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
          gap: 6px;
        }
        .fa-grid-shots li {
          display: flex;
          gap: 7px;
          padding: 6px 8px;
          background: var(--fa-card);
          border: 1px solid var(--fa-line);
          border-radius: 6px;
        }
        .fa-grid-shot-idx {
          font-family: var(--fa-mono);
          font-size: 10px;
          font-weight: 600;
          color: var(--fa-amber);
          flex-shrink: 0;
        }
        .fa-grid-shot-body {
          min-width: 0;
          flex: 1;
        }
        .fa-grid-shot-scene {
          font-size: 11px;
          font-weight: 600;
          color: var(--fa-ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-grid-shot-prompt {
          margin: 2px 0 0;
          font-size: 10px;
          color: var(--fa-ink3);
          font-family: var(--fa-mono);
          line-height: 1.45;
        }
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-spin {
            animation: none;
          }
        }
      `}</style>
    </section>
  );
}
