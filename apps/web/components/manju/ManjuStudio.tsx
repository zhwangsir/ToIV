"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  generateStoryboard,
  generateTxt2img,
  generateVideo,
  imageUrl,
  jobEventsUrl,
  listModels,
  uploadImage,
} from "@/lib/api";
import type { GenerateResponse, ModelsResponse } from "@/lib/types";

import { ShotCard } from "./ShotCard";
import { ShotInspector } from "./ShotInspector";
import { toShotCards } from "./types";
import type { ShotCard as ShotCardModel } from "./types";

type FlowStep = "script" | "characters" | "storyboard" | "video" | "export";
type AutoMode = "auto" | "manual";

const FLOW_STEPS: { key: FlowStep; label: string; hint: string }[] = [
  { key: "script", label: "剧本", hint: "写下剧情梗概" },
  { key: "characters", label: "角色", hint: "登记出场角色" },
  { key: "storyboard", label: "分镜", hint: "拆解 + 逐镜出图" },
  { key: "video", label: "视频", hint: "关键帧转视频" },
  { key: "export", label: "导出", hint: "M2 起合成成片" },
];

const NEGATIVE = "blurry, lowres, deformed, bad anatomy, extra fingers, watermark, text, jpeg artifacts";

// 单镜 16:9 关键帧,适合后续转视频
const SHOT_W = 768;
const SHOT_H = 432;

interface CharRow {
  name: string;
  desc: string;
}

export function ManjuStudio() {
  // 顶栏 / 流程
  const [projectName, setProjectName] = useState("未命名漫剧");
  const [autoMode, setAutoMode] = useState<AutoMode>("manual");
  const [step, setStep] = useState<FlowStep>("script");

  // 剧本 / 角色配置
  const [premise, setPremise] = useState("");
  const [numShots, setNumShots] = useState(6);
  const [style, setStyle] = useState("anime, cinematic lighting");
  const [chars, setChars] = useState<CharRow[]>([]);

  // 模型
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [ckpt, setCkpt] = useState("");

  // 分镜板
  const [shots, setShots] = useState<ShotCardModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 运行态
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        setCkpt(m.checkpoints[0] ?? "");
      })
      .catch(() => {});
    return () => esRef.current?.close();
  }, []);

  const patchShot = useCallback((id: string, patch: Partial<ShotCardModel>) => {
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  // 跟踪一个出图作业:完成 → 回填缩略图 + worker/filename(供转视频复用)
  const trackImage = (id: string, res: GenerateResponse) =>
    new Promise<void>((resolve) => {
      const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      esRef.current = es;
      let done = false;
      es.addEventListener("done", (e) => {
        done = true;
        const d = JSON.parse((e as MessageEvent).data);
        const first: string | undefined = (d.images ?? [])[0];
        if (first) {
          patchShot(id, { status: "image", imageUrl: imageUrl(first), imageWorker: res.worker });
        } else {
          patchShot(id, { status: "error", error: "没有产出图片" });
        }
        es.close();
        resolve();
      });
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        let msg = "出图出错";
        if (data) {
          try {
            msg = JSON.parse(data).message;
          } catch {
            /* keep default */
          }
        } else if (done) {
          return;
        } else {
          msg = "与服务器连接中断";
        }
        patchShot(id, { status: "error", error: msg });
        es.close();
        resolve();
      });
    });

  // 跟踪一个转视频作业:完成 → 回填视频
  const trackVideo = (id: string, res: GenerateResponse) =>
    new Promise<void>((resolve) => {
      const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      esRef.current = es;
      let done = false;
      es.addEventListener("done", (e) => {
        done = true;
        const d = JSON.parse((e as MessageEvent).data);
        const first: string | undefined = (d.images ?? [])[0];
        patchShot(id, first ? { status: "video", videoUrl: imageUrl(first) } : { status: "image" });
        es.close();
        resolve();
      });
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (!data && done) return;
        let msg = "转视频出错";
        if (data) {
          try {
            msg = JSON.parse(data).message;
          } catch {
            /* keep default */
          }
        }
        patchShot(id, { status: "error", error: msg });
        es.close();
        resolve();
      });
    });

  // 单镜出图:txt2img(shot.description 作正向提示词)
  const imageOne = useCallback(
    async (shot: ShotCardModel) => {
      const prompt = shot.description.trim();
      if (!prompt) {
        patchShot(shot.id, { status: "error", error: "提示词为空" });
        return;
      }
      patchShot(shot.id, { status: "imaging", error: undefined });
      const res = await generateTxt2img({
        positive: prompt,
        negative: NEGATIVE,
        ckpt_name: ckpt,
        width: SHOT_W,
        height: SHOT_H,
        steps: 20,
        cfg: 7,
        sampler: "euler",
        scheduler: "normal",
        batch_size: 1,
      });
      await trackImage(shot.id, res);
    },
    [ckpt, patchShot],
  );

  // 单镜转视频:把缩略图取回 → 上传到 worker → generateVideo
  const videoOne = useCallback(
    async (shot: ShotCardModel) => {
      if (!shot.imageUrl) return;
      patchShot(shot.id, { status: "imaging", error: undefined });
      setStage("生成视频…(约 1-2 分钟)");
      try {
        const blob = await (await fetch(shot.imageUrl)).blob();
        const file = new File([blob], "keyframe.png", { type: blob.type || "image/png" });
        const up = await uploadImage(file, "video");
        const res = await generateVideo({
          positive: shot.description || "subtle natural motion, cinematic",
          image: up.filename,
          worker: up.worker,
          width: SHOT_W,
          height: SHOT_H,
          length: 49,
          fps: 16,
        });
        await trackVideo(shot.id, res);
      } catch (e) {
        patchShot(shot.id, { status: "error", error: (e as Error).message });
      } finally {
        setStage("");
      }
    },
    [patchShot],
  );

  // 生成分镜:剧情 → LLM → shots
  const planStoryboard = useCallback(async () => {
    const p = premise.trim();
    if (!p || planning) return;
    esRef.current?.close();
    setError(null);
    setPlanning(true);
    setStage("AI 正在拆解分镜…");
    try {
      const out = await generateStoryboard({
        premise: p,
        num_shots: numShots,
        style: style.trim() || undefined,
        characters: chars.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), desc: c.desc.trim() })),
      });
      const cards = toShotCards(out.shots);
      setShots(cards);
      setSelectedId(cards[0]?.id ?? null);
      setStep("storyboard");
      if (autoMode === "auto") {
        // 全自动:分镜出来后立即批量出图
        void imageAll(cards);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
      setStage("");
    }
    // imageAll 在下方定义,planStoryboard 仅在用户操作时触发,故不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [premise, planning, numShots, style, chars, autoMode]);

  // 批量出图:串行跑(单实例 ComfyUI 排队即可,避免一次性塞爆)
  const imageAll = useCallback(
    async (list?: ShotCardModel[]) => {
      if (busy) return;
      const targets = (list ?? shots).filter((s) => s.description.trim());
      if (targets.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (let i = 0; i < targets.length; i++) {
          setStage(`批量出图 ${i + 1}/${targets.length}…`);
          await imageOne(targets[i]);
        }
      } finally {
        setBusy(false);
        setStage("");
      }
    },
    [busy, shots, imageOne],
  );

  const runImageOne = useCallback(
    async (id: string) => {
      const shot = shots.find((s) => s.id === id);
      if (!shot || busy) return;
      setBusy(true);
      setError(null);
      try {
        await imageOne(shot);
      } finally {
        setBusy(false);
      }
    },
    [shots, busy, imageOne],
  );

  const runVideoOne = useCallback(
    async (id: string) => {
      const shot = shots.find((s) => s.id === id);
      if (!shot || busy) return;
      setBusy(true);
      setError(null);
      try {
        await videoOne(shot);
      } finally {
        setBusy(false);
      }
    },
    [shots, busy, videoOne],
  );

  const addChar = () => setChars((prev) => [...prev, { name: "", desc: "" }]);
  const patchChar = (i: number, patch: Partial<CharRow>) =>
    setChars((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeChar = (i: number) => setChars((prev) => prev.filter((_, idx) => idx !== i));

  const selected = shots.find((s) => s.id === selectedId) ?? null;
  const selectedIndex = selected ? shots.findIndex((s) => s.id === selected.id) : -1;
  const doneCount = shots.filter((s) => s.imageUrl).length;

  return (
    <div className="manju-studio">
      {/* 顶栏 */}
      <header className="manju-topbar">
        <input
          className="manju-project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="项目名"
        />
        <div className="manju-mode seg" role="group" aria-label="创作模式">
          <button
            type="button"
            className={autoMode === "auto" ? "active" : ""}
            onClick={() => setAutoMode("auto")}
          >
            ⚡ 全自动
          </button>
          <button
            type="button"
            className={autoMode === "manual" ? "active" : ""}
            onClick={() => setAutoMode("manual")}
          >
            ✎ 手动精修
          </button>
        </div>
        <span className="manju-progress-chip">
          {doneCount}/{shots.length || numShots} 镜已出图
        </span>
      </header>

      <div className="manju-body">
        {/* 左侧流程轨 */}
        <nav className="manju-rail" aria-label="制作流程">
          {FLOW_STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`manju-rail-step${step === s.key ? " active" : ""}`}
              onClick={() => setStep(s.key)}
            >
              <span className="manju-rail-no">{i + 1}</span>
              <span className="manju-rail-label">{s.label}</span>
              <span className="manju-rail-hint">{s.hint}</span>
            </button>
          ))}
        </nav>

        {/* 中间:配置 + 分镜板 */}
        <main className="manju-main">
          {(step === "script" || step === "characters" || shots.length === 0) && (
            <section className="manju-setup">
              <h2>
                漫剧 <span className="grad">导演台</span>
              </h2>
              <div className="field">
                <label htmlFor="manju-premise">剧情梗概</label>
                <textarea
                  id="manju-premise"
                  rows={4}
                  placeholder="例:雨夜的便利店,失忆少女与店长在一杯热咖啡间慢慢拼回过去……"
                  value={premise}
                  onChange={(e) => setPremise(e.target.value)}
                />
              </div>

              <div className="manju-setup-row">
                <div className="field">
                  <label>
                    镜头数<span className="hint">{numShots} 镜</span>
                  </label>
                  <div className="seg" role="group" aria-label="镜头数">
                    {[4, 6, 8, 12].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={numShots === n ? "active" : ""}
                        onClick={() => setNumShots(n)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="manju-style">画风</label>
                  <input
                    id="manju-style"
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    placeholder="anime, watercolor, cinematic…"
                  />
                </div>
              </div>

              <div className="field">
                <label>
                  角色登记
                  <button type="button" className="manju-add-char" onClick={addChar}>
                    + 添加角色
                  </button>
                </label>
                {chars.length === 0 && (
                  <p className="manju-setup-hint">可选。登记后分镜会按角色分配镜头(M2 起做角色一致性)。</p>
                )}
                {chars.map((c, i) => (
                  <div className="manju-char-row" key={i}>
                    <input
                      placeholder="名字"
                      value={c.name}
                      onChange={(e) => patchChar(i, { name: e.target.value })}
                    />
                    <input
                      placeholder="外貌 / 设定(英文更利于出图)"
                      value={c.desc}
                      onChange={(e) => patchChar(i, { desc: e.target.value })}
                    />
                    <button type="button" className="manju-char-del" onClick={() => removeChar(i)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {models && models.checkpoints.length > 0 && (
                <div className="field">
                  <label>出图模型</label>
                  <select value={ckpt} onChange={(e) => setCkpt(e.target.value)}>
                    {models.checkpoints.map((c) => (
                      <option key={c} value={c}>
                        {c.replace(/\.safetensors$/, "")}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="button"
                className="generate-btn"
                disabled={planning || !premise.trim()}
                onClick={planStoryboard}
              >
                {planning ? stage || "拆解中…" : autoMode === "auto" ? "⚡ 生成分镜并全部出图" : "生成分镜"}
              </button>
              {error && <div className="alert">⚠ {error}</div>}
            </section>
          )}

          {shots.length > 0 && (step === "storyboard" || step === "video" || step === "export") && (
            <section className="manju-board-wrap">
              <div className="manju-board-head">
                <h2>
                  分镜板 <span className="grad">{shots.length} 镜</span>
                </h2>
                <div className="manju-board-tools">
                  {(busy || planning) && stage && <span className="chat-typing">{stage}</span>}
                  <button
                    type="button"
                    className="manju-secondary-btn"
                    disabled={busy}
                    onClick={() => imageAll()}
                  >
                    {busy ? "出图中…" : "全部出图"}
                  </button>
                  <button
                    type="button"
                    className="manju-ghost-btn"
                    disabled={busy || planning}
                    onClick={() => setStep("script")}
                  >
                    ← 改剧本
                  </button>
                </div>
              </div>
              {error && <div className="alert">⚠ {error}</div>}
              <div className="manju-board">
                {shots.map((shot, i) => (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    index={i}
                    selected={shot.id === selectedId}
                    busy={busy}
                    onSelect={setSelectedId}
                    onImage={runImageOne}
                    onVideo={runVideoOne}
                  />
                ))}
              </div>
            </section>
          )}
        </main>

        {/* 右侧:选中镜头属性 */}
        <ShotInspector
          shot={selected}
          index={selectedIndex}
          busy={busy}
          onChange={patchShot}
          onImage={runImageOne}
          onVideo={runVideoOne}
        />
      </div>
    </div>
  );
}
