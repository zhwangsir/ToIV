"use client";

/**
 * LibTV 式短剧工作台 —— 阶段④:短片生成页(Team C)。
 *
 * 左栏镜头详情(场次/镜头下拉切换、关联资产三槽、故事板/首帧/参考图槽位、
 * 分时段画面描述只读参考、模型+参数条、「生成镜头」主按钮带帧数预估、
 * confirmedShots 门控)+ 中央大播放器(video_url 直播、无视频占位、右上
 * 后处理浮层占位、「连续播放」自动跳下一张)+ 播放器下方任务日志精简条
 * (最近 3 条 + 查看全部)。零新 API,全部走 dp。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { imageUrl, type DramaShotItem } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { StageStubProps } from "./types";
import { ShotStatusBadge, shotTone } from "./ShotTableRow";

// 与 DramaWorkbench 容器同一阶梯:generating/ready 视为分镜已确认
const SHOTS_CONFIRMED_STATUSES = new Set(["generating", "ready"]);

/** 分时段标记:「0-3秒」「0.5-3 秒」等(支持 - – ~ 连接符) */
const SEG_RE = /(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*秒/g;

/** 把含分时段标记的描述拆成 [{time, text}];无标记返回 null(整段渲染)。 */
function splitSegments(text: string): { time: string; text: string }[] | null {
  const matches = [...text.matchAll(SEG_RE)];
  if (matches.length === 0) return null;
  return matches.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end =
      i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    return {
      time: m[0],
      text: text
        .slice(start, end)
        .trim()
        .replace(/^[,，:：\s]+/, ""),
    };
  });
}

/** 任务耗时:<60s 显示秒,否则 Xm Ys(与旧 TaskLogPanel 一致) */
function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function StageProduce({ dp, confirmedShots: confirmedProp }: StageStubProps) {
  const shots = dp.shots;
  const project = dp.current;
  const confirmed =
    confirmedProp ?? SHOTS_CONFIRMED_STATUSES.has(project?.status ?? "");
  const shot: DramaShotItem | null = dp.selectedShot ?? shots[0] ?? null;

  const [continuous, setContinuous] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [charPickerOpen, setCharPickerOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const scenes = useMemo(() => {
    const out: string[] = [];
    for (const s of shots) {
      const key = s.scene || "";
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }, [shots]);
  const sceneShots = useMemo(
    () => shots.filter((s) => (s.scene || "") === (shot?.scene ?? "")),
    [shots, shot?.scene],
  );

  const videoSrc = shot
    ? shot.continue_concat_url || shot.lipsync_video_url || shot.video_url
    : "";
  const videoDone = shot ? shotTone(shot.video_status) === "done" : false;
  const fps = project?.fps && project.fps > 0 ? project.fps : 24;
  const estFrames = shot ? Math.round((shot.duration_sec || 0) * fps) : 0;
  const busyThis = shot !== null && dp.busyShot === shot.id;

  // 连续播放:当前镜播完 → 跳下一张已完成镜头
  const nextDoneShot = useMemo(() => {
    if (!shot) return null;
    const idx = shots.findIndex((s) => s.id === shot.id);
    for (let i = idx + 1; i < shots.length; i++) {
      if (shotTone(shots[i].video_status) === "done") return shots[i];
    }
    return null;
  }, [shots, shot]);

  // 切镜后连续播放模式下自动起播(用户已交互过,play() 失败静默)
  useEffect(() => {
    if (continuous && videoSrc) {
      videoRef.current?.play().catch(() => {});
    }
  }, [continuous, videoSrc, shot?.id]);

  const handleEnded = () => {
    if (continuous && nextDoneShot) dp.setSelectedShotId(nextDoneShot.id);
  };

  const shotChars = (shot?.characters ?? [])
    .map((name) => dp.characters.find((c) => c.name === name))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const addableChars = dp.characters.filter(
    (c) => !(shot?.characters ?? []).includes(c.name),
  );
  const patchCharacters = (next: string[]) => {
    if (!shot) return;
    void dp.saveShot(shot, {
      prompt: shot.prompt,
      dialogue: shot.dialogue,
      scene: shot.scene,
      characters: next,
    });
  };

  const promptSegs = shot ? splitSegments(shot.prompt || "") : null;
  const logEntries = logOpen ? dp.taskLog : dp.taskLog.slice(0, 3);

  if (!shot) {
    return (
      <div className="wb-empty-hint">
        还没有分镜;请先完成阶段③分镜,再进入短片制作
      </div>
    );
  }

  return (
    <div className="wb-produce">
      {/* ── 左栏:镜头详情 ── */}
      <div className="wb-pdetail">
        <div className="wb-pdetail-selects">
          <select
            className="wb-select"
            aria-label="场次"
            value={shot.scene || ""}
            onChange={(e) => {
              const first = shots.find((s) => (s.scene || "") === e.target.value);
              if (first) dp.setSelectedShotId(first.id);
            }}
          >
            {scenes.map((sc, i) => (
              <option key={sc || "__none"} value={sc}>
                {sc || `场次 ${i + 1}`}
              </option>
            ))}
          </select>
          <select
            className="wb-select"
            aria-label="镜头"
            value={shot.id}
            onChange={(e) => dp.setSelectedShotId(e.target.value)}
          >
            {sceneShots.map((s) => (
              <option key={s.id} value={s.id}>
                镜头 #{s.idx}
              </option>
            ))}
          </select>
        </div>

        <div className="wb-pdetail-status">
          <ShotStatusBadge status={shot.video_status} error={shot.error} label="视频" />
          {!!shot.dialogue && (
            <ShotStatusBadge status={shot.voice_status} label="配音" />
          )}
          {shotTone(shot.lipsync_status) === "done" && (
            <ShotStatusBadge status={shot.lipsync_status} label="口型" />
          )}
          {shotTone(shot.continue_status) === "done" && (
            <ShotStatusBadge status={shot.continue_status} label="续写" />
          )}
        </div>

        {/* 关联资产三槽(2026-08-16 批 2:中栏密度过高,折叠卡默认收起;
            原生 details 零脚本,chevron 旋转走 token 时长) */}
        <details className="wb-fold">
          <summary className="wb-fold-head">
            <span className="wb-fold-chevron" aria-hidden="true">
              <Icon name="chevron-down" size={12} />
            </span>
            关联资产
            <span className="wb-dim">角色 {shotChars.length}</span>
          </summary>
          <div className="wb-assetslots">
          <div className="wb-assetslot">
            <div className="wb-assetslot-head">
              <Icon name="users" size={12} />
              角色
              <button
                type="button"
                className="wb-icon-btn"
                title="关联项目角色到本镜头"
                aria-expanded={charPickerOpen}
                disabled={addableChars.length === 0}
                onClick={() => setCharPickerOpen((v) => !v)}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            <div className="wb-assetslot-body">
              {shotChars.length === 0 && <span className="wb-dim">—</span>}
              {shotChars.map((c) => (
                <span key={c.id} className="wb-chip">
                  {c.name}
                  <button
                    type="button"
                    className="wb-chip-x"
                    title={`从镜头移除「${c.name}」`}
                    aria-label={`从镜头移除 ${c.name}`}
                    onClick={() =>
                      patchCharacters(
                        (shot.characters ?? []).filter((n) => n !== c.name),
                      )
                    }
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
            {charPickerOpen && addableChars.length > 0 && (
              <div className="wb-assetslot-picker">
                {addableChars.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="wb-chip wb-chip-btn"
                    onClick={() => {
                      patchCharacters([...(shot.characters ?? []), c.name]);
                      setCharPickerOpen(false);
                    }}
                  >
                    <Icon name="plus" size={10} />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="wb-assetslot">
            <div className="wb-assetslot-head">
              <Icon name="image" size={12} />
              场景
            </div>
            <div className="wb-assetslot-body">
              {shot.scene ? (
                <span className="wb-chip">{shot.scene}</span>
              ) : (
                <span className="wb-dim">—</span>
              )}
            </div>
          </div>
          <div className="wb-assetslot">
            <div className="wb-assetslot-head">
              <Icon name="box" size={12} />
              道具
              <button
                type="button"
                className="wb-icon-btn"
                title="道具关联二期开放"
                disabled
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            <div className="wb-assetslot-body">
              <span className="wb-dim">—</span>
            </div>
          </div>
          </div>
        </details>

        {/* 故事板 / 首帧 / 参考图槽位 */}
        <div className="wb-media-slots">
          <div className="wb-media-slot">
            {shot.keyframe_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl(shot.keyframe_url)}
                alt="故事板"
                width={96}
                height={96}
              />
            ) : (
              <>
                <Icon name="image" size={16} strokeWidth={1.2} />
                <span>故事板</span>
              </>
            )}
          </div>
          <div className="wb-media-slot">
            {videoSrc ? (
              <video src={imageUrl(videoSrc)} preload="metadata" muted />
            ) : (
              <>
                <Icon name="film" size={16} strokeWidth={1.2} />
                <span>首帧</span>
              </>
            )}
          </div>
          <div className="wb-media-slot">
            {shotChars[0]?.reference_front ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl(shotChars[0].reference_front)}
                alt={`参考图:${shotChars[0].name}`}
                width={96}
                height={96}
              />
            ) : (
              <>
                <Icon name="user" size={16} strokeWidth={1.2} />
                <span>参考图</span>
              </>
            )}
          </div>
        </div>

        {/* 画面描述(只读;分时段则按段格式化) */}
        <div className="wb-pdetail-desc">
          <div className="wb-pdetail-label">
            画面描述
            {shot.mood && <span className="wb-chip">{shot.mood}</span>}
          </div>
          {shot.beat && (
            <div className="wb-seg">
              <span className="wb-seg-time">beat</span>
              <span className="wb-seg-text">{shot.beat}</span>
            </div>
          )}
          {promptSegs ? (
            promptSegs.map((seg) => (
              <div key={seg.time} className="wb-seg">
                <span className="wb-seg-time">{seg.time}</span>
                <span className="wb-seg-text">{seg.text}</span>
              </div>
            ))
          ) : (
            <p className="wb-pdetail-prompt">{shot.prompt || "(无描述)"}</p>
          )}
        </div>

        {/* 模型 + 参数条 */}
        <div className="wb-pdetail-params">
          {dp.videoGenerators.filter((g) => g.available).length > 0 && (
            <select
              className="wb-select"
              aria-label="视频生成模型"
              value={dp.videoModel}
              onChange={(e) => dp.setVideoModel(e.target.value)}
            >
              {dp.videoGenerators
                .filter((g) => g.available)
                .map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.display_name || g.name}
                  </option>
                ))}
            </select>
          )}
          <span className="wb-chip" title="单镜时长(项目值)">
            {(shot.duration_sec || 0).toFixed(1)}s
          </span>
          <span className="wb-chip" title="分辨率(项目值)">
            {project?.width ?? 0}×{project?.height ?? 0}
          </span>
          <span className="wb-chip" title="帧率(项目值)">
            {fps}fps
          </span>
        </div>

        <button
          type="button"
          className="btn btn-primary wb-generate-btn"
          disabled={!confirmed || busyThis || dp.busyShot !== null}
          title={
            !confirmed
              ? "请先在分镜页确认分镜"
              : busyThis
                ? "生成中…"
                : `生成镜头 #${shot.idx}(约 ${estFrames} 帧 @ ${fps}fps)`
          }
          onClick={() =>
            dp.generateVideoV2(shot.id, {
              model: dp.videoModel,
              steps: 20,
              cfg: 1.0,
            })
          }
        >
          <Icon name={busyThis ? "loading" : "video"} size={14} />
          {busyThis
            ? "生成中…"
            : videoDone
              ? `重新生成(约 ${estFrames} 帧)`
              : `生成镜头(约 ${estFrames} 帧)`}
        </button>
      </div>

      {/* ── 中央:大播放器 + 任务日志 ── */}
      <div className="wb-pmain">
        <div
          className="wb-player"
          style={{
            aspectRatio:
              project?.width && project?.height
                ? `${project.width} / ${project.height}`
                : "16 / 9",
          }}
        >
          {videoSrc ? (
            <video
              key={videoSrc}
              ref={videoRef}
              controls
              preload="metadata"
              src={imageUrl(videoSrc)}
              onEnded={handleEnded}
            />
          ) : (
            <div className="wb-player-ph">
              <span className="wb-player-ph-idx">#{shot.idx}</span>
              <ShotStatusBadge status={shot.video_status} error={shot.error} />
              <span className="wb-dim">尚未生成视频</span>
            </div>
          )}
          {/* 后处理浮层(二期占位) */}
          <div className="wb-player-overlay">
            <button type="button" className="wb-icon-btn" title="超分(二期)" disabled>
              <Icon name="zoom-in" size={13} />
            </button>
            <button type="button" className="wb-icon-btn" title="反推(二期)" disabled>
              <Icon name="wand" size={13} />
            </button>
          </div>
        </div>
        <div className="wb-player-bar">
          <button
            type="button"
            className={`wb-chip wb-chip-btn${continuous ? " is-active" : ""}`}
            title="播放完自动跳下一张已完成镜头"
            aria-pressed={continuous}
            onClick={() => setContinuous((v) => !v)}
          >
            <Icon name="skip-forward" size={12} />
            连续播放
          </button>
          {continuous && (
            <span className="wb-dim">
              {nextDoneShot ? `下一张:#${nextDoneShot.idx}` : "后面没有已完成镜头"}
            </span>
          )}
        </div>

        {/* 任务日志精简条 */}
        <div className="wb-tlog">
          <div className="wb-tlog-head">
            <Icon name="history" size={12} />
            <span>任务日志</span>
            <button
              type="button"
              className="wb-icon-text-btn"
              aria-expanded={logOpen}
              onClick={() => setLogOpen((v) => !v)}
            >
              {logOpen ? "收起" : "查看全部"}
            </button>
          </div>
          <div className={`wb-tlog-list${logOpen ? " is-open" : ""}`}>
            {logEntries.length === 0 && (
              <div className="wb-tlog-item">
                <span className="wb-dim">暂无任务记录</span>
              </div>
            )}
            {logEntries.map((e) => (
              <div
                key={`${e.key}-${e.endedAt ?? e.startedAt}`}
                className={`wb-tlog-item${e.status === "running" ? " is-running" : ""}`}
              >
                <Icon
                  name={
                    e.status === "running"
                      ? "refresh"
                      : e.status === "error"
                        ? "warning"
                        : "check"
                  }
                  size={11}
                />
                <span className="wb-tlog-label">{e.label}</span>
                <span className="wb-tlog-dur">
                  {e.status === "running"
                    ? "进行中"
                    : e.endedAt
                      ? fmtDur(e.endedAt - e.startedAt)
                      : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
