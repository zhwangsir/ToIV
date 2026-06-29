"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  assembleManju,
  generateAudio,
  generateStoryboard,
  generateTxt2img,
  generateVideo,
  imageUrl,
  lipsyncManjuShot,
  listModels,
  renderManjuShot,
  saveManjuShots,
  synthManjuVoice,
  uploadImage,
  uploadVoiceRef,
} from "@/lib/api";
import type { ManjuAspect, ManjuTransition } from "@/lib/api";
import { useActivity } from "@/components/nav/ActivityContext";
import { ModelPicker } from "@/components/ui/ModelPicker";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useFauxProgress } from "@/hooks/useFauxProgress";
import { trackJob } from "@/lib/trackJob";
import type { GenerateResponse, ModelsResponse } from "@/lib/types";

import { ManjuProjectBar, shotCardToInput } from "./ManjuProjectBar";
import type { ProjectLoaded } from "./ManjuProjectBar";
import { ShotCard } from "./ShotCard";
import { ShotInspector } from "./ShotInspector";
import { composeShotPrompt, toShotCards } from "./types";
import type { CharRow, ShotCard as ShotCardModel } from "./types";

type FlowStep = "script" | "characters" | "storyboard" | "video" | "export";
type AutoMode = "auto" | "manual";

const FLOW_STEPS: { key: FlowStep; label: string; hint: string }[] = [
  { key: "script", label: "剧本", hint: "写下剧情梗概" },
  { key: "characters", label: "角色", hint: "登记出场角色" },
  { key: "storyboard", label: "分镜", hint: "拆解 + 逐镜出图" },
  { key: "video", label: "视频", hint: "关键帧转视频" },
  { key: "export", label: "导出", hint: "自动剪辑 → 成片" },
];

const NEGATIVE = "blurry, lowres, deformed, bad anatomy, extra fingers, watermark, text, jpeg artifacts";

// 单镜 16:9 关键帧,适合后续转视频
// 关键帧用 SDXL 16:9 训练档 ~1MP(1344×768)。旧 768×432=0.33MP 远低于 SDXL 甜点会糊/掉细节;
// /generate/txt2img 不做 fit_resolution,故此处必须给到位的像素档。
const SHOT_W = 1344;
const SHOT_H = 768;

// 角色参考图(肖像):正方形更利于 IPAdapter 取脸
// 角色定妆三视图(turnaround)用宽幅,容纳 正/侧/背 多视图(SDXL ~1MP 横档)
const REF_W = 1216;
const REF_H = 832;

// 漫剧默认底模:优先 SDXL 动漫系。按 2026 调研排名 NoobAI(vpred 旗舰画质)>Illustrious
// (稳定+LoRA 生态)>Pony>Animagine。命不中回退列表首个。用户仍可在 ModelPicker 任意切换。
const PREFERRED_CKPT_FAMILIES = ["noob", "illustrious", "pony", "animagine"] as const;

// vpred 模型(NoobAI 等)在高 cfg 会过饱和压暗(实测 cfg7 把阳光场景渲染成阴暗),
// 需低 cfg(~4.5);EPS 模型(Illustrious/Animagine/Pony)用常规 ~7。
function cfgForCkpt(ckpt: string): number {
  return /vpred|v-pred|v_pred/i.test(ckpt) ? 4.5 : 7;
}

function pickDefaultCkpt(checkpoints: readonly string[]): string {
  for (const family of PREFERRED_CKPT_FAMILIES) {
    const hit = checkpoints.find((c) => c.toLowerCase().includes(family));
    if (hit) return hit;
  }
  return checkpoints[0] ?? "";
}

function isPreferredCkpt(ckpt: string): boolean {
  const lower = ckpt.toLowerCase();
  return PREFERRED_CKPT_FAMILIES.some((family) => lower.includes(family));
}

export function ManjuStudio() {
  // 顶栏 / 流程
  const [projectName, setProjectName] = useState("未命名漫剧");
  const [projectId, setProjectId] = useState<string | null>(null);
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
  // 是否有角色参考图正在生成 / 上传(同一时刻只跑一个,避免抢占单实例 ComfyUI)
  const [refBusy, setRefBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // 导出 / 自动剪辑
  const [transition, setTransition] = useState<ManjuTransition>("crossfade");
  const [withSubs, setWithSubs] = useState(true);
  const [bgmUrl, setBgmUrl] = useState("");
  const [bgmMood, setBgmMood] = useState("");
  const [bgmGenerating, setBgmGenerating] = useState(false);
  const [aspect, setAspect] = useState<ManjuAspect>("16:9");
  const [titleText, setTitleText] = useState("");
  const [creditsText, setCreditsText] = useState("");
  const [assembling, setAssembling] = useState(false);
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);
  const [assembleErr, setAssembleErr] = useState<string | null>(null);
  const [bgmProgress, setBgmProgress] = useState<number | null>(null);

  // 全局活动(灵动岛)+ 成片拼接估算进度(ffmpeg 无中间进度,用估算条)
  const { setActivity, clearActivity } = useActivity();
  const assemblePct = useFauxProgress(assembling, 12000);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        setCkpt(pickDefaultCkpt(m.checkpoints));
      })
      .catch(() => {});
    return () => esRef.current?.close();
  }, []);

  // 把本地运行态映射到灵动岛活动(全局可见):任一操作进行→running 进度,全部结束→done 脉冲后收。
  const wasBusy = useRef(false);
  useEffect(() => {
    const running = shots.find((s) => s.status === "imaging" || s.voicing || s.lipSyncing);
    const active = busy || planning || assembling || bgmGenerating || !!running;
    if (active) {
      const pct = running?.progress ?? (bgmGenerating ? bgmProgress : assembling ? assemblePct : null);
      const label = assembling
        ? "合成成片…"
        : bgmGenerating
          ? "AI 配乐生成…"
          : stage || (running ? running.scene || "出图中" : "漫剧合成");
      setActivity({
        kind: "manju",
        label,
        value: pct ?? null,
        max: pct != null ? 100 : null,
        phase: "running",
      });
      wasBusy.current = true;
    } else if (wasBusy.current) {
      wasBusy.current = false;
      setActivity({ kind: "manju", label: "完成", value: 100, max: 100, phase: "done" });
      const id = window.setTimeout(() => clearActivity(), 760);
      return () => window.clearTimeout(id);
    }
  }, [busy, planning, assembling, bgmGenerating, bgmProgress, assemblePct, shots, stage, setActivity, clearActivity]);

  const patchShot = useCallback((id: string, patch: Partial<ShotCardModel>) => {
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const patchCharAt = useCallback((i: number, patch: Partial<CharRow>) => {
    setChars((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }, []);

  // 解析参考图作业首张产物文件名(参考图生成:不回填分镜,只取 filename)。
  const trackRefFilename = (res: GenerateResponse, onPct?: (pct: number) => void) =>
    trackJob(res, {
      onProgress: onPct ? (p) => onPct(p.pct) : undefined,
      register: (es) => { esRef.current = es; },
    }).then((paths) => {
      const first = paths[0];
      if (!first) throw new Error("没有产出图片");
      return first;
    });

  // 解析 ACE-Step 配乐作业的产物音频文件名(导出步 AI 配乐用),进度回调到配乐区进度条。
  const trackAudioFilename = (res: GenerateResponse, onPct?: (pct: number) => void) =>
    trackJob(res, {
      onProgress: onPct ? (p) => onPct(p.pct) : undefined,
      register: (es) => { esRef.current = es; },
    }).then((paths) => {
      const audio = paths.find((p) => /\.(mp3|flac|wav|opus)/i.test(p)) ?? paths[0];
      if (!audio) throw new Error("没有产出音频");
      return audio;
    });

  // 跟踪对口型作业:进度回填卡片,完成 → 用口型同步视频替换 videoUrl(配音仍由成片对白轨提供)
  const trackLipsync = (id: string, res: GenerateResponse) =>
    trackJob(res, {
      onProgress: (p) => patchShot(id, { progress: p.pct }),
      register: (es) => { esRef.current = es; },
    }).then(
      (paths) => {
        const first = paths[0];
        patchShot(
          id,
          first
            ? { videoUrl: imageUrl(first), lipSyncing: false, lipSynced: true, status: "video", progress: null, runPhase: undefined }
            : { lipSyncing: false, error: "对口型没有产出视频", progress: null, runPhase: undefined },
        );
      },
      (e: Error) => patchShot(id, { lipSyncing: false, error: e.message, progress: null, runPhase: undefined }),
    );

  // 跟踪一个出图作业:进度回填卡片,完成 → 回填缩略图 + worker/filename(供转视频复用)
  const trackImage = (id: string, res: GenerateResponse) =>
    trackJob(res, {
      onProgress: (p) => patchShot(id, { progress: p.pct }),
      register: (es) => { esRef.current = es; },
    }).then(
      (paths) => {
        const first = paths[0];
        patchShot(
          id,
          first
            ? { status: "image", imageUrl: imageUrl(first), imageWorker: res.worker, progress: null, runPhase: undefined }
            : { status: "error", error: "没有产出图片", progress: null, runPhase: undefined },
        );
      },
      (e: Error) => patchShot(id, { status: "error", error: e.message, progress: null, runPhase: undefined }),
    );

  // 跟踪一个转视频作业:进度回填卡片,完成 → 回填视频
  const trackVideo = (id: string, res: GenerateResponse) =>
    trackJob(res, {
      onProgress: (p) => patchShot(id, { progress: p.pct }),
      register: (es) => { esRef.current = es; },
    }).then(
      (paths) => {
        const first = paths[0];
        patchShot(
          id,
          first
            ? { status: "video", videoUrl: imageUrl(first), progress: null, runPhase: undefined }
            : { status: "image", progress: null, runPhase: undefined },
        );
      },
      (e: Error) => patchShot(id, { status: "error", error: e.message, progress: null, runPhase: undefined }),
    );

  // 单镜出图:出场角色中若有带参考图者(取第一个)→ renderManjuShot 走 IPAdapter 人物一致;
  //          否则保持原 txt2img。两路结果都用同一 trackImage 回填。
  const imageOne = useCallback(
    async (shot: ShotCardModel) => {
      const base = shot.description.trim();
      if (!base) {
        patchShot(shot.id, { status: "error", error: "提示词为空" });
        return;
      }
      // 资产 @引用:把出场角色的固定 danbooru 描述并入提示词(角色一致性)
      const prompt = composeShotPrompt(base, shot.characters, chars);
      // cfg 按底模族自适应:vpred 模型须低 cfg 防过饱和压暗
      const cfg = cfgForCkpt(ckpt);
      patchShot(shot.id, { status: "imaging", error: undefined, progress: null, runPhase: "image" });
      // AI 润色产出的反向词叠加到基础 NEGATIVE 之上(内容感知,逐镜定制)
      const negative = shot.negative?.trim() ? `${NEGATIVE}, ${shot.negative.trim()}` : NEGATIVE;

      // 该镜出场角色里第一个登记了参考图的 → 走人物一致性出图
      const refChar = chars.find(
        (c) => c.refImage && c.refWorker && shot.characters.includes(c.name.trim()),
      );

      if (refChar?.refImage && refChar.refWorker) {
        try {
          const res = await renderManjuShot({
            positive: prompt,
            worker: refChar.refWorker,
            characterRef: refChar.refImage,
            negative,
            ckptName: ckpt,
            width: SHOT_W,
            height: SHOT_H,
            steps: 20,
            cfg,
            sampler: "euler",
            scheduler: "normal",
          });
          await trackImage(shot.id, res);
          return;
        } catch (e) {
          // 该 worker 无 ip-adapter 模型等 → 友好提示,降级到普通 txt2img,不崩
          const why = (e as Error).message;
          setError(`「${refChar.name.trim()}」人物一致性出图失败(${why}),已降级为普通出图`);
        }
      }

      const res = await generateTxt2img({
        positive: prompt,
        negative,
        ckpt_name: ckpt,
        width: SHOT_W,
        height: SHOT_H,
        steps: 20,
        cfg,
        sampler: "euler",
        scheduler: "normal",
        batch_size: 1,
      });
      await trackImage(shot.id, res);
    },
    [ckpt, chars, patchShot],
  );

  // 单镜转视频:把缩略图取回 → 上传到 worker → generateVideo
  const videoOne = useCallback(
    async (shot: ShotCardModel) => {
      if (!shot.imageUrl) return;
      patchShot(shot.id, { status: "imaging", error: undefined, progress: null, runPhase: "video" });
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
      // 已打开项目则把新分镜自动落库(生成即持久,可追踪)
      if (projectId) {
        void saveManjuShots(projectId, cards.map(shotCardToInput)).catch(() => {});
      }
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
  }, [premise, planning, numShots, style, chars, autoMode, projectId]);

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

  // 单镜配音:台词→TTS 合成,用「说话角色」定妆音色克隆;回填 voiceUrl(成片混入对白轨)
  const voiceOne = useCallback(
    async (shot: ShotCardModel) => {
      const text = (shot.dialogue || "").trim();
      if (!text) {
        patchShot(shot.id, { error: "该镜没有台词,先在分镜里填写台词" });
        return;
      }
      patchShot(shot.id, { voicing: true, error: undefined, runPhase: "voice" });
      try {
        // 说话角色 → 其定妆音色克隆;缺省取出场角色第一个
        const speaker = (shot.speaker || shot.characters[0] || "").trim();
        const speakerChar = speaker
          ? chars.find((c) => c.name.trim() === speaker && c.refAudio)
          : undefined;
        const refAudioUrl = speakerChar?.refAudio ? imageUrl(speakerChar.refAudio) : undefined;
        const r = await synthManjuVoice({
          text,
          ...(refAudioUrl ? { ref_audio_url: refAudioUrl } : {}),
        });
        patchShot(shot.id, { voicing: false, voiceUrl: r.url, runPhase: undefined });
      } catch (e) {
        patchShot(shot.id, { voicing: false, error: (e as Error).message, runPhase: undefined });
      }
    },
    [patchShot, chars],
  );

  const runVoiceOne = useCallback(
    async (id: string) => {
      const shot = shots.find((s) => s.id === id);
      if (!shot || busy) return;
      setBusy(true);
      setError(null);
      try {
        await voiceOne(shot);
      } finally {
        setBusy(false);
      }
    },
    [shots, busy, voiceOne],
  );

  // 单镜对口型:源视频 + 配音 → LatentSync 让嘴型对上台词,完成后替换 videoUrl
  const lipsyncOne = useCallback(
    async (shot: ShotCardModel) => {
      if (!shot.videoUrl || !shot.voiceUrl) {
        patchShot(shot.id, { error: "需先有视频和配音才能对口型" });
        return;
      }
      patchShot(shot.id, { lipSyncing: true, error: undefined, progress: null, runPhase: "lipsync" });
      try {
        const res = await lipsyncManjuShot({
          video_url: shot.videoUrl,
          voice_url: imageUrl(shot.voiceUrl),
        });
        await trackLipsync(shot.id, res);
      } catch (e) {
        patchShot(shot.id, { lipSyncing: false, error: (e as Error).message, runPhase: undefined });
      }
    },
    [patchShot],
  );

  const runLipsyncOne = useCallback(
    async (id: string) => {
      const shot = shots.find((s) => s.id === id);
      if (!shot || busy) return;
      setBusy(true);
      setError(null);
      try {
        await lipsyncOne(shot);
      } finally {
        setBusy(false);
      }
    },
    [shots, busy, lipsyncOne],
  );

  // 批量配音:给所有有台词、尚未配音的镜串行合成(单 TTS 实例,排队即可),带进度
  const voiceAll = useCallback(async () => {
    if (busy) return;
    const targets = shots.filter((s) => (s.dialogue || "").trim() && !s.voiceUrl);
    if (targets.length === 0) {
      setError("没有待配音的镜(都已配音或无台词)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        setStage(`批量配音 ${i + 1}/${targets.length}…`);
        await voiceOne(targets[i]);
      }
    } finally {
      setBusy(false);
      setStage("");
    }
  }, [busy, shots, voiceOne]);

  // 自动剪辑:把已转视频的镜头按序拼成成片(可选转场 / 字幕 / BGM)
  const assemble = useCallback(async () => {
    if (assembling) return;
    const clipShots = shots.filter((s) => s.videoUrl);
    if (clipShots.length === 0) {
      setAssembleErr("还没有视频片段,先到「视频」步把分镜转成视频");
      return;
    }
    setAssembling(true);
    setAssembleErr(null);
    setAssembledUrl(null);
    try {
      const clips = clipShots.map((s) => s.videoUrl as string);
      const subtitles = withSubs ? clipShots.map((s) => (s.dialogue || "").trim()) : [];
      // 配音同样过 imageUrl 带 token,后端 _download_clip 才能鉴权取到
      const voiceUrls = clipShots.map((s) => (s.voiceUrl ? imageUrl(s.voiceUrl) : ""));
      const r = await assembleManju(
        clips,
        {
          transition,
          bgm_url: bgmUrl.trim() || null,
          subtitles,
          fps: 16,
          aspect,
          title: titleText.trim(),
          credits: creditsText.trim(),
        },
        voiceUrls,
      );
      setAssembledUrl(r.url);
    } catch (e) {
      setAssembleErr((e as Error).message);
    } finally {
      setAssembling(false);
    }
  }, [assembling, shots, withSubs, transition, bgmUrl, aspect, titleText, creditsText]);

  // AI 配乐:用 ACE-Step 按情绪/风格生成 BGM(时长跟成片),产物填入 bgmUrl。
  const generateBgm = useCallback(async () => {
    if (bgmGenerating) return;
    const mood =
      bgmMood.trim() ||
      (style.trim() ? `${style.trim()}, cinematic, emotional` : "cinematic emotional orchestral, gentle, ambient");
    setBgmGenerating(true);
    setBgmProgress(null);
    setAssembleErr(null);
    try {
      const total = shots.reduce((a, s) => a + (s.duration_sec || 3), 0);
      const seconds = Math.min(240, Math.max(20, total || 30));
      const res = await generateAudio({ tags: mood, lyrics: "", seconds });
      const audio = await trackAudioFilename(res, setBgmProgress);
      setBgmUrl(imageUrl(audio));
    } catch (e) {
      setAssembleErr((e as Error).message);
    } finally {
      setBgmGenerating(false);
      setBgmProgress(null);
    }
    // trackAudioFilename 为稳定闭包,不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgmGenerating, bgmMood, style, shots]);

  const addChar = () => setChars((prev) => [...prev, { name: "", desc: "" }]);
  const patchChar = (i: number, patch: Partial<CharRow>) => patchCharAt(i, patch);
  const removeChar = (i: number) => setChars((prev) => prev.filter((_, idx) => idx !== i));

  // 用角色设定 txt2img 出一张肖像作参考图;完成后把 filename + worker 存到该角色。
  const generateCharRef = useCallback(
    async (i: number) => {
      if (refBusy) return;
      const c = chars[i];
      const desc = c?.desc.trim();
      if (!c || !desc) {
        patchCharAt(i, { refStatus: "error", refError: "先填角色外貌设定" });
        return;
      }
      setRefBusy(true);
      patchCharAt(i, { refStatus: "imaging", refError: undefined, refProgress: null });
      try {
        // 定妆三视图:多视图 turnaround(角色一致性锚定参考),danbooru 标签 + 净背景
        const styleTag = style.trim() ? `, ${style.trim()}` : "";
        const positive =
          `character reference sheet, multiple views, character turnaround, ` +
          `front view, side view, back view, full body, same character, ${desc}, ` +
          `simple white background, masterpiece, best quality, very aesthetic, highly detailed${styleTag}`;
        const res = await generateTxt2img({
          positive,
          negative: NEGATIVE,
          ckpt_name: ckpt,
          width: REF_W,
          height: REF_H,
          steps: 28,
          cfg: cfgForCkpt(ckpt),
          sampler: "euler",
          scheduler: "normal",
          batch_size: 1,
        });
        const filename = await trackRefFilename(res, (pct) => patchCharAt(i, { refProgress: pct }));
        patchCharAt(i, {
          refImage: filename,
          refWorker: res.worker,
          refStatus: "idle",
          refError: undefined,
          refProgress: null,
        });
      } catch (e) {
        patchCharAt(i, { refStatus: "error", refError: (e as Error).message, refProgress: null });
      } finally {
        setRefBusy(false);
      }
    },
    // trackRefFilename 为稳定闭包(仅用 esRef + jobEventsUrl),不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refBusy, chars, style, ckpt, patchCharAt],
  );

  // 上传一张参考图(IPAdapter 用):存 filename + worker 到该角色。
  const uploadCharRef = useCallback(
    async (i: number, file: File) => {
      if (refBusy) return;
      setRefBusy(true);
      patchCharAt(i, { refStatus: "imaging", refError: undefined });
      try {
        const up = await uploadImage(file, "manju-ref");
        patchCharAt(i, {
          refImage: up.filename,
          refWorker: up.worker,
          refStatus: "idle",
          refError: undefined,
        });
      } catch (e) {
        patchCharAt(i, { refStatus: "error", refError: (e as Error).message });
      } finally {
        setRefBusy(false);
      }
    },
    [refBusy, patchCharAt],
  );

  // 上传角色定妆音色参考音:后端 ffmpeg 归一为 wav,存 refAudio(该角色台词的克隆嗓音)。
  const uploadCharVoice = useCallback(
    async (i: number, file: File) => {
      const c = chars[i];
      if (!c || c.voiceUploading) return;
      patchCharAt(i, { voiceUploading: true, refError: undefined });
      try {
        const r = await uploadVoiceRef(file);
        patchCharAt(i, { refAudio: r.url, voiceUploading: false });
      } catch (e) {
        patchCharAt(i, { voiceUploading: false, refError: (e as Error).message });
      }
    },
    [chars, patchCharAt],
  );

  // 试听角色音色:用其参考音克隆合成一句样本并即时播放。
  const auditionCharVoice = useCallback(
    async (i: number) => {
      const c = chars[i];
      if (!c?.refAudio || busy) return;
      setBusy(true);
      setError(null);
      try {
        const name = c.name.trim();
        const sample = name ? `大家好，我是${name}。` : "你好，这是音色试听。";
        const r = await synthManjuVoice({ text: sample, ref_audio_url: imageUrl(c.refAudio) });
        await new Audio(imageUrl(r.url)).play().catch(() => {});
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [chars, busy],
  );

  // 防抖自动保存:分镜变更(配音 / 说话角色 / 台词等)1.5s 后落库,刷新不丢配音。
  useEffect(() => {
    if (!projectId || shots.length === 0) return;
    const t = setTimeout(() => {
      void saveManjuShots(projectId, shots.map(shotCardToInput)).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [shots, projectId]);

  const selected = shots.find((s) => s.id === selectedId) ?? null;
  const selectedIndex = selected ? shots.findIndex((s) => s.id === selected.id) : -1;
  // 检视器只在有分镜且处于分镜/视频步时显示;否则收起,主区铺满(避免 step1 空挂)。
  const showInspector = shots.length > 0 && (step === "storyboard" || step === "video");
  const doneCount = shots.filter((s) => s.imageUrl).length;
  const videoCount = shots.filter((s) => s.videoUrl).length;

  // 各步完成度(纯视觉:流程轨打勾用,不改数据流)
  const stepDone: Record<FlowStep, boolean> = {
    script: premise.trim().length > 0,
    characters: chars.some((c) => c.name.trim()),
    storyboard: doneCount > 0,
    video: videoCount > 0,
    export: !!assembledUrl,
  };

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

      {/* 项目库:保存/打开/删除(可追踪/可复用)。打开即回填整台状态。 */}
      <ManjuProjectBar
        currentId={projectId}
        onCurrentIdChange={setProjectId}
        snapshot={{ title: projectName, premise, style, ckpt, shots, chars }}
        onLoad={(d: ProjectLoaded) => {
          setProjectName(d.title || "未命名漫剧");
          setPremise(d.premise);
          setStyle(d.style);
          if (d.ckpt) setCkpt(d.ckpt);
          setChars(d.chars);
          setShots(d.shots);
          if (d.shots.length) setStep("storyboard");
        }}
        onNew={() => {
          setProjectName("未命名漫剧");
          setPremise("");
          setChars([]);
          setShots([]);
          setStep("script");
        }}
      />

      <div className={`manju-body${showInspector ? "" : " is-wide"}`}>
        {/* 左侧流程轨 */}
        <nav className="manju-rail" aria-label="制作流程">
          {FLOW_STEPS.map((s, i) => {
            const isActive = step === s.key;
            const isDone = stepDone[s.key] && !isActive;
            return (
              <button
                key={s.key}
                type="button"
                className={`manju-rail-step${isActive ? " active" : ""}${isDone ? " done" : ""}`}
                aria-current={isActive ? "step" : undefined}
                onClick={() => setStep(s.key)}
              >
                <span className="manju-rail-no" aria-hidden="true">
                  {isDone ? "✓" : i + 1}
                </span>
                <span className="manju-rail-label">{s.label}</span>
                <span className="manju-rail-hint">{s.hint}</span>
              </button>
            );
          })}
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
                    {[6, 12, 18, 24].map((n) => (
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
                  <p className="manju-setup-hint">
                    可选。给角色生成 / 上传一张参考图,出场镜头将走 IPAdapter 保持人物一致。
                  </p>
                )}
                {chars.map((c, i) => {
                  const refImaging = c.refStatus === "imaging";
                  const canRef = !!c.desc.trim() && !refBusy && !refImaging;
                  return (
                    <div className="manju-char-card" key={i}>
                      <div className="manju-char-row">
                        {/* 参考图缩略 / 占位:点击占位即生成 */}
                        <button
                          type="button"
                          className={`manju-char-ref-thumb${c.refImage ? " has-ref" : ""}`}
                          disabled={!canRef}
                          aria-busy={refImaging}
                          title={c.refImage ? "重新生成参考图" : "用角色设定生成参考图"}
                          onClick={() => void generateCharRef(i)}
                        >
                          {c.refImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imageUrl(c.refImage)} alt={`${c.name || "角色"} 参考图`} />
                          ) : refImaging ? (
                            <ProgressBar variant="ring" ringSize={34} value={c.refProgress ?? null} />
                          ) : (
                            <span className="manju-char-ref-add" aria-hidden="true">
                              ✦
                            </span>
                          )}
                        </button>
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
                        <button
                          type="button"
                          className="manju-char-del"
                          onClick={() => removeChar(i)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="manju-char-ref-tools">
                        <button
                          type="button"
                          className="manju-char-ref-btn"
                          disabled={!canRef}
                          onClick={() => void generateCharRef(i)}
                        >
                          {refImaging ? "生成参考图中…" : c.refImage ? "↻ 重生成参考图" : "✦ 生成参考图"}
                        </button>
                        <label className="manju-char-ref-upload">
                          上传参考图
                          <input
                            type="file"
                            accept="image/*"
                            disabled={refBusy || refImaging}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void uploadCharRef(i, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        {c.refImage && !refImaging && (
                          <span className="manju-char-ref-ok">✓ 一致性已就绪</span>
                        )}
                        {c.refStatus === "error" && c.refError && (
                          <span className="manju-char-ref-err">⚠ {c.refError}</span>
                        )}
                      </div>
                      {/* 音色:该角色台词的克隆嗓音 */}
                      <div className="manju-char-voice-tools">
                        <label className="manju-char-voice-upload">
                          {c.voiceUploading ? "音色上传中…" : c.refAudio ? "↻ 换音色" : "🎙 上传音色"}
                          <input
                            type="file"
                            accept="audio/*"
                            disabled={c.voiceUploading}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void uploadCharVoice(i, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        {c.refAudio && (
                          <button
                            type="button"
                            className="manju-char-voice-btn"
                            disabled={busy}
                            onClick={() => void auditionCharVoice(i)}
                            title="用该音色试听一句"
                          >
                            ▶ 试听
                          </button>
                        )}
                        {c.refAudio && <span className="manju-char-voice-ok">🔊 音色已就绪</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {models && models.checkpoints.length > 0 && (
                <ModelPicker
                  models={models.checkpoints}
                  value={ckpt}
                  onChange={setCkpt}
                  label="出图模型"
                />
              )}
              {models && models.checkpoints.length > 0 && (
                <p className="manju-setup-hint">
                  {isPreferredCkpt(ckpt)
                    ? "✓ 已选 SDXL 动漫底模 — 角色脸一致性更稳"
                    : "建议选 SDXL 动漫底模(animagine / illustrious / noobai),角色一致性更稳"}
                </p>
              )}

              <button
                type="button"
                className="generate-btn"
                disabled={planning || !premise.trim()}
                onClick={planStoryboard}
              >
                {planning ? stage || "拆解中…" : autoMode === "auto" ? "⚡ 生成分镜并全部出图" : "生成分镜"}
              </button>
              {planning && (
                <ProgressBar
                  active
                  value={null}
                  label={stage || "AI 拆解分镜中…"}
                  className="manju-plan-progress"
                />
              )}
              {error && <div className="alert">⚠ {error}</div>}
            </section>
          )}

          {shots.length > 0 && (step === "storyboard" || step === "video") && (
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
                    className="manju-secondary-btn"
                    disabled={busy}
                    onClick={() => voiceAll()}
                    title="给所有有台词、尚未配音的镜批量合成配音"
                  >
                    🎙 全部配音
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
                    onVoice={runVoiceOne}
                    onLipsync={runLipsyncOne}
                  />
                ))}
              </div>
            </section>
          )}

          {shots.length > 0 && step === "export" && (
            <section className="manju-board-wrap">
              <div className="manju-board-head">
                <h2>
                  成片导出 <span className="grad">自动剪辑</span>
                </h2>
                <div className="manju-board-tools">
                  <span className="manju-progress-chip">
                    {videoCount}/{shots.length} 镜有视频
                  </span>
                  <button
                    type="button"
                    className="manju-ghost-btn"
                    disabled={assembling}
                    onClick={() => setStep("video")}
                  >
                    ← 回视频
                  </button>
                </div>
              </div>

              {videoCount === 0 ? (
                <div className="manju-export-empty">
                  <span className="manju-export-empty-mark" aria-hidden="true">
                    ▷
                  </span>
                  <p>
                    还没有视频片段。先到「视频」步,把分镜逐镜转成视频,再回来一键合成成片。
                  </p>
                </div>
              ) : (
                <div className="manju-export">
                  {/* 成片灯箱播放器:有成片时大图沉浸,无则占位 */}
                  <div className={`manju-export-stage${assembledUrl ? " has-film" : ""}`}>
                    {assembledUrl ? (
                      <video
                        className="manju-export-film"
                        src={imageUrl(assembledUrl)}
                        controls
                        playsInline
                        autoPlay
                      />
                    ) : (
                      <div className="manju-export-placeholder" aria-hidden="true">
                        <span className="manju-export-placeholder-mark">◷</span>
                        <span className="manju-export-placeholder-text">
                          {assembling ? "正在合成成片…" : `${videoCount} 镜就绪 · 待合成`}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 合成控件:转场 / 字幕 / BGM 收成精致行 */}
                  <div className="manju-export-controls">
                    <div className="manju-export-opts">
                      <div className="field">
                        <label>转场</label>
                        <div className="seg seg-2" role="group" aria-label="转场">
                          {(["crossfade", "none"] as ManjuTransition[]).map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={transition === t ? "active" : ""}
                              onClick={() => setTransition(t)}
                            >
                              {t === "crossfade" ? "交叠淡入" : "硬切"}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="field">
                        <label>画幅 · 平台</label>
                        <div className="seg seg-3" role="group" aria-label="画幅">
                          {(
                            [
                              { v: "16:9", label: "横屏", hint: "B站 / YouTube" },
                              { v: "9:16", label: "竖屏", hint: "抖音 / 快手" },
                              { v: "1:1", label: "方屏", hint: "Instagram" },
                            ] as { v: ManjuAspect; label: string; hint: string }[]
                          ).map((a) => (
                            <button
                              key={a.v}
                              type="button"
                              className={aspect === a.v ? "active" : ""}
                              onClick={() => setAspect(a.v)}
                              title={a.hint}
                            >
                              {a.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <label className="manju-export-check">
                        <input
                          type="checkbox"
                          checked={withSubs}
                          onChange={(e) => setWithSubs(e.target.checked)}
                        />
                        <span>烧录字幕(用各镜台词)</span>
                      </label>
                    </div>

                    <div className="field">
                      <label htmlFor="manju-bgm">配乐 BGM</label>
                      <div className="manju-bgm-ai">
                        <input
                          className="manju-bgm-mood"
                          value={bgmMood}
                          onChange={(e) => setBgmMood(e.target.value)}
                          disabled={bgmGenerating}
                          placeholder="情绪 / 风格(留空跟剧集风格,如 epic orchestral, tense)"
                        />
                        <button
                          type="button"
                          className="manju-bgm-gen-btn"
                          disabled={bgmGenerating}
                          aria-busy={bgmGenerating}
                          onClick={generateBgm}
                          title="用 ACE-Step 按情绪生成配乐(时长跟成片)"
                        >
                          {bgmGenerating ? "生成中…" : "✨ AI 配乐"}
                        </button>
                      </div>
                      {bgmGenerating && (
                        <ProgressBar
                          active
                          tone="voice"
                          value={bgmProgress}
                          label="AI 配乐编曲中…"
                          className="manju-bgm-progress"
                        />
                      )}
                      <input
                        id="manju-bgm"
                        value={bgmUrl}
                        onChange={(e) => setBgmUrl(e.target.value)}
                        placeholder="音乐文件 URL,留空则无配乐(或点 AI 配乐生成)"
                      />
                      {bgmUrl && (
                        <audio className="manju-bgm-preview" src={bgmUrl} controls preload="none" />
                      )}
                    </div>

                    <div className="manju-bookends">
                      <div className="field">
                        <label htmlFor="manju-title">片头标题(可选)</label>
                        <input
                          id="manju-title"
                          value={titleText}
                          onChange={(e) => setTitleText(e.target.value)}
                          placeholder="如:第一话 · 命运的相遇"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="manju-credits">片尾字幕(可选)</label>
                        <input
                          id="manju-credits"
                          value={creditsText}
                          onChange={(e) => setCreditsText(e.target.value)}
                          placeholder="如:制作 · ToIV 工作室"
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      className="generate-btn"
                      disabled={assembling || videoCount === 0}
                      aria-busy={assembling}
                      onClick={assemble}
                    >
                      {assembling
                        ? "合成中…(下载片段 + ffmpeg 拼接)"
                        : `🎬 合成成片(${videoCount} 镜)`}
                    </button>

                    {assembling && (
                      <ProgressBar
                        active
                        tone="success"
                        value={assemblePct}
                        label="合成成片…(下载片段 + ffmpeg 拼接)"
                        className="manju-assemble-progress"
                      />
                    )}

                    {assembleErr && <div className="alert">⚠ {assembleErr}</div>}

                    {assembledUrl && (
                      <a
                        className="manju-secondary-btn manju-export-download"
                        href={imageUrl(assembledUrl)}
                        download
                      >
                        ↓ 下载成片
                      </a>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </main>

        {/* 右侧:选中镜头属性(仅在有分镜的分镜/视频步显示)*/}
        {showInspector && (
          <ShotInspector
            shot={selected}
            index={selectedIndex}
            busy={busy}
            onChange={patchShot}
            onImage={runImageOne}
            onVideo={runVideoOne}
            onVoice={runVoiceOne}
            onLipsync={runLipsyncOne}
          />
        )}
      </div>
    </div>
  );
}
