"use client";

import { useEffect, useState } from "react";

import { imageUrl, refineDramaScript, polishDramaScript } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface ScriptTabProps {
  project: UseDramaProjectReturn;
}

/**
 * 剧本拆解 + 宫格分镜 Tab。
 * - 剧本拆解:镜头数输入 + AI 拆分镜 / 重新拆解 + 剧本预览
 * - 宫格分镜:9/25 宫格生成 + 结果展示(宫格图 + 分镜列表)
 */
export function ScriptTab({ project }: ScriptTabProps) {
  const {
    current,
    patchProject,
    storyboarding,
    storyboard,
    showGridPicker,
    setShowGridPicker,
    gridBusy,
    gridStoryboard,
    gridResult,
    gridError,
    gridImage,
    gridShots,
    clearGridResult,
    setRefPreview,
  } = project;

  // 拆分镜镜头数(本地状态,避免污染共享 hook)
  const [numShots, setNumShots] = useState(6);
  const { show: showToast } = useToast();

  // 剧本编辑态:L2 润色 / L3 精修作用于该 textarea 内容,完成后回写并持久化。
  // 仅在切换项目时从 current.script 同步,避免后端刷新覆盖用户本地编辑。
  const [scriptText, setScriptText] = useState(current?.script ?? "");
  const [refining, setRefining] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [confirmRefine, setConfirmRefine] = useState(false);
  const [confirmPolish, setConfirmPolish] = useState(false);
  useEffect(() => {
    setScriptText(current?.script ?? "");
  }, [current?.id]);

  useEffect(() => {
    if (confirmRefine) {
      const t = setTimeout(() => setConfirmRefine(false), 4000);
      return () => clearTimeout(t);
    }
  }, [confirmRefine]);
  useEffect(() => {
    if (confirmPolish) {
      const t = setTimeout(() => setConfirmPolish(false), 4000);
      return () => clearTimeout(t);
    }
  }, [confirmPolish]);

  if (!current) return null;

  /** L2 主力润色:二次确认后送 refine 接口,用返回 refined 替换 textarea 并持久化到项目。 */
  const handleRefine = async () => {
    if (!current) return;
    const text = scriptText.trim();
    if (!text) {
      showToast("error", "剧本内容为空,无法润色");
      return;
    }
    if (!confirmRefine) {
      setConfirmRefine(true);
      setConfirmPolish(false);
      return;
    }
    setConfirmRefine(false);
    setRefining(true);
    try {
      const res = await refineDramaScript(current.id, scriptText);
      const refined = res.refined ?? scriptText;
      setScriptText(refined);
      try {
        await patchProject({ script: refined });
        showToast("success", "L2 润色完成,已保存到项目");
      } catch (persistErr) {
        showToast(
          "error",
          `润色已完成,但保存失败:${persistErr instanceof Error ? persistErr.message : "未知错误"}。已替换文本框内容,请手动保存。`,
        );
      }
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "L2 润色失败");
    } finally {
      setRefining(false);
    }
  };

  /** L3 终稿精修:耗时较长(2-5 分钟),二次确认后送 polish 接口,用返回 polished 替换并持久化。 */
  const handlePolish = async () => {
    if (!current) return;
    const text = scriptText.trim();
    if (!text) {
      showToast("error", "剧本内容为空,无法精修");
      return;
    }
    if (!confirmPolish) {
      setConfirmPolish(true);
      setConfirmRefine(false);
      return;
    }
    setConfirmPolish(false);
    setPolishing(true);
    showToast("success", "L3 精修已开始,预计 2-5 分钟");
    try {
      const res = await polishDramaScript(current.id, scriptText);
      const polished = res.polished ?? scriptText;
      setScriptText(polished);
      try {
        await patchProject({ script: polished });
        showToast("success", "L3 终稿精修完成,已保存到项目");
      } catch (persistErr) {
        showToast(
          "error",
          `精修已完成,但保存失败:${persistErr instanceof Error ? persistErr.message : "未知错误"}。已替换文本框内容,请手动保存。`,
        );
      }
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "L3 精修失败");
    } finally {
      setPolishing(false);
    }
  };

  return (
    <>
      {current.script && (
        <section className="ds-section ds-storyboard-bar card">
          <div className="ds-section-head">
            <Icon name="film" size={14} />
            <span className="ds-section-title">剧本拆解</span>
          </div>
          <div className="ds-storyboard-controls">
            <label className="ds-field ds-field-sm">
              <span className="ds-field-label">镜头数</span>
              <input
                className="ds-input"
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
              className="btn btn-sm"
              onClick={() => storyboard(numShots)}
              disabled={storyboarding}
            >
              {storyboarding ? (
                <>
                  <Icon name="loading" size={13} className="ds-spin" />
                  拆解中…
                </>
              ) : (
                <>
                  <Icon name="refresh" size={13} />
                  重新拆解
                </>
              )}
            </button>

            {/* M2:9/25 宫格分镜 */}
            <div className="ds-grid-bar">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowGridPicker((v) => !v)}
                disabled={gridBusy}
                title="一次性产出 9/25 张分镜并拼成宫格图"
              >
                {gridBusy ? (
                  <>
                    <Icon name="loading" size={13} className="ds-spin" />
                    宫格生成中…
                  </>
                ) : (
                  <>
                    <Icon name="grid" size={13} />
                    宫格分镜
                  </>
                )}
              </button>
              {showGridPicker && !gridBusy && (
                <div className="ds-grid-picker" role="menu">
                  <button
                    type="button"
                    className="ds-grid-pick"
                    onClick={() => gridStoryboard(9)}
                  >
                    <Icon name="grid" size={14} />
                    <span>
                      <strong>9 宫格</strong>
                      <em>3×3 · 9 镜速览</em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ds-grid-pick"
                    onClick={() => gridStoryboard(25)}
                  >
                    <Icon name="grid" size={14} />
                    <span>
                      <strong>25 宫格</strong>
                      <em>5×5 · 25 镜全貌</em>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <details className="ds-script-preview">
            <summary>查看剧本</summary>
            <div
              className="ds-script-tools"
              style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}
            >
              <button
                type="button"
                className={`btn btn-sm ${confirmRefine ? "btn-danger" : ""}`}
                onClick={handleRefine}
                disabled={refining || polishing}
                title="L2 主力模型润色剧本"
              >
                {refining ? (
                  <>
                    <Icon name="loading" size={13} className="ds-spin" />
                    润色中…
                  </>
                ) : confirmRefine ? (
                  <>
                    <Icon name="warning" size={13} />
                    确认润色?
                  </>
                ) : (
                  <>
                    <Icon name="sparkles" size={13} />
                    L2 润色
                  </>
                )}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${confirmPolish ? "btn-danger" : ""}`}
                onClick={handlePolish}
                disabled={refining || polishing}
                title="L3 终稿精修(耗时 2-5 分钟)"
              >
                {polishing ? (
                  <>
                    <Icon name="loading" size={13} className="ds-spin" />
                    精修中…
                  </>
                ) : confirmPolish ? (
                  <>
                    <Icon name="warning" size={13} />
                    确认精修?
                  </>
                ) : (
                  <>
                    <Icon name="check" size={13} />
                    L3 精修
                  </>
                )}
              </button>
            </div>
            <textarea
              className="ds-script-pre"
              rows={12}
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="剧本内容…"
              disabled={refining || polishing}
            />
          </details>
        </section>
      )}

      {/* M2:宫格分镜结果(9=3×3 / 25=5×5)*/}
      {(gridImage || gridError || gridBusy) && (
        <section className="ds-section ds-grid-section card">
          <div className="ds-section-head">
            <Icon name="grid" size={14} />
            <span className="ds-section-title">宫格分镜</span>
            {gridShots.length > 0 && (
              <span className="ds-section-count">{gridShots.length}</span>
            )}
            {gridImage && !gridBusy && (
              <a
                className="btn btn-ghost btn-sm ds-grid-dl"
                href={imageUrl(gridImage)}
                target="_blank"
                rel="noreferrer"
                title="新窗口查看大图"
              >
                <Icon name="eye" size={12} />
                查看大图
              </a>
            )}
            {gridResult && !gridBusy && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={clearGridResult}
                title="收起宫格结果"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          {gridError && <div className="ds-error-inline">{gridError}</div>}

          {gridBusy && (
            <div className="ds-grid-loading">
              <Icon name="loading" size={20} className="ds-spin" />
              <span>正在生成宫格分镜,稍候…</span>
            </div>
          )}

          {!gridBusy && gridImage && (
            <div
              className="ds-grid-image"
              style={{
                gridTemplateColumns: `repeat(${
                  gridShots.length === 25 ? 5 : 3
                }, 1fr)`,
              }}
            >
              <img
                src={imageUrl(gridImage)}
                alt="宫格分镜图"
                className="ds-grid-img"
                onClick={() =>
                  setRefPreview({ url: gridImage, label: "宫格分镜图" })
                }
              />
            </div>
          )}

          {!gridBusy && gridShots.length > 0 && (
            <ul className="ds-grid-shots">
              {gridShots.map((s, i) => (
                <li key={s.id ?? i} className="ds-grid-shot">
                  <span className="ds-grid-shot-idx">#{s.idx}</span>
                  <div className="ds-grid-shot-body">
                    <div className="ds-grid-shot-scene" title={s.scene}>
                      {s.scene || `分镜 ${s.idx}`}
                    </div>
                    {s.prompt && (
                      <p className="ds-grid-shot-prompt">
                        {s.prompt.slice(0, 50)}
                        {s.prompt.length > 50 ? "…" : ""}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
