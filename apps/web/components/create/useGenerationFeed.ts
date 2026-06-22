"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  generate3D,
  generateImg2img,
  generateTxt2img,
  generateTxt2video,
  generateVideo,
  generateAudio,
  imageUrl,
  jobEventsUrl,
  uploadImage,
} from "@/lib/api";
import type {
  GenerateResponse,
  Img2ImgGenParams,
  Txt2ImgParams,
} from "@/lib/types";
import type {
  Txt2VideoParams,
  WanI2VGenParams,
  Gen3DParams,
  AudioGenParams,
} from "@/lib/api";

import { type ResultItem, type ResultKind, type ResultMeta, nextId } from "./types";

/** 一次提交所需的派发载荷:由面板构建,hook 负责执行 + 追踪。 */
export type Dispatch =
  | { type: "txt2img"; params: Txt2ImgParams; prompt: string; meta: ResultMeta }
  | { type: "img2img"; params: Img2ImgGenParams; prompt: string; meta: ResultMeta }
  | { type: "txt2video"; params: Txt2VideoParams; prompt: string }
  | { type: "video"; params: WanI2VGenParams; prompt: string }
  | { type: "model3d"; params: Gen3DParams; prompt: string }
  | { type: "audio"; params: AudioGenParams; prompt: string };

interface FeedState {
  busy: boolean;
  stage: string;
  error: string | null;
  results: ResultItem[];
}

async function submit(d: Dispatch): Promise<GenerateResponse> {
  switch (d.type) {
    case "txt2img":
      return generateTxt2img(d.params);
    case "img2img":
      return generateImg2img(d.params);
    case "txt2video":
      return generateTxt2video(d.params);
    case "video":
      return generateVideo(d.params);
    case "model3d":
      return generate3D(d.params);
    case "audio":
      return generateAudio(d.params);
  }
}

function kindOf(d: Dispatch): ResultKind {
  if (d.type === "txt2img" || d.type === "img2img") return "image";
  if (d.type === "txt2video" || d.type === "video") return "video";
  if (d.type === "model3d") return "model3d";
  return "audio";
}

function classifyPath(path: string, fallback: ResultKind): ResultKind {
  const p = path.toLowerCase();
  if (p.includes(".glb")) return "model3d";
  if (/\.(mp3|flac|wav|opus|ogg)/.test(p)) return "audio";
  if (/\.(mp4|webm|gif)/.test(p)) return "video";
  return fallback === "audio" || fallback === "model3d" ? "image" : fallback;
}

/** 统一创作台的生成引擎:提交 → SSE 追踪 → 结果流 → 续创作动作。 */
export function useGenerationFeed() {
  const [state, setState] = useState<FeedState>({
    busy: false,
    stage: "",
    error: null,
    results: [],
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => () => esRef.current?.close(), []);

  const setStage = useCallback((stage: string) => {
    setState((s) => ({ ...s, stage }));
  }, []);

  const track = useCallback(
    (res: GenerateResponse, kind: ResultKind, prompt: string, meta?: ResultMeta) =>
      new Promise<void>((resolve) => {
        const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
        esRef.current = es;
        let done = false;
        es.addEventListener("progress", (e) => {
          try {
            const d = JSON.parse((e as MessageEvent).data);
            if (d.max > 0) setStage(`采样中 ${d.value}/${d.max} 步`);
          } catch {
            /* ignore */
          }
        });
        es.addEventListener("done", (e) => {
          done = true;
          let paths: string[] = [];
          try {
            paths = (JSON.parse((e as MessageEvent).data).images as string[]) ?? [];
          } catch {
            /* ignore */
          }
          const items: ResultItem[] = paths.map((p) => ({
            id: nextId(),
            kind: classifyPath(p, kind),
            url: imageUrl(p),
            prompt,
            meta,
          }));
          setState((s) => ({ ...s, results: [...items, ...s.results] }));
          es.close();
          resolve();
        });
        es.addEventListener("error", (e) => {
          const data = (e as MessageEvent).data;
          if (data) {
            let msg = "生成出错";
            try {
              msg = JSON.parse(data).message;
            } catch {
              /* ignore */
            }
            setState((s) => ({ ...s, error: msg }));
            es.close();
            resolve();
          } else if (!done) {
            setState((s) => ({ ...s, error: "与服务器连接中断" }));
            es.close();
            resolve();
          }
        });
      }),
    [setStage],
  );

  /** 面板调用:派发一次生成并跟踪到结果流。 */
  const run = useCallback(
    async (dispatches: Dispatch[], initialStage: string) => {
      esRef.current?.close();
      setState((s) => ({ ...s, busy: true, error: null, stage: initialStage }));
      try {
        for (const d of dispatches) {
          const res = await submit(d);
          const meta = "meta" in d ? d.meta : undefined;
          await track(res, kindOf(d), d.prompt, meta);
        }
      } catch (e) {
        setState((s) => ({ ...s, error: (e as Error).message }));
      } finally {
        setState((s) => ({ ...s, busy: false, stage: "" }));
      }
    },
    [track],
  );

  // ---------- 续创作:不重配参数,从结果直接迭代 ----------

  const fileFromResult = useCallback(async (item: ResultItem): Promise<File> => {
    const blob = await (await fetch(item.url)).blob();
    return new File([blob], "ref.png", { type: blob.type || "image/png" });
  }, []);

  /** 把某张图片结果转成视频(图生视频,沿用其画幅比例)。 */
  const continueToVideo = useCallback(
    async (item: ResultItem) => {
      if (state.busy) return;
      try {
        setState((s) => ({ ...s, busy: true, error: null, stage: "上传参考图…" }));
        const file = await fileFromResult(item);
        const up = await uploadImage(file, "video");
        const w = item.meta?.width ?? 832;
        const h = item.meta?.height ?? 480;
        // 维持横竖比,落到视频常用尺寸
        const landscape = w >= h;
        setStage("生成视频…(约 1-2 分钟)");
        const res = await generateVideo({
          positive: item.prompt || "subtle natural motion, cinematic",
          image: up.filename,
          worker: up.worker,
          width: landscape ? 832 : 480,
          height: landscape ? 480 : 832,
          length: 81,
          fps: 16,
        });
        await track(res, "video", item.prompt);
      } catch (e) {
        setState((s) => ({ ...s, error: (e as Error).message }));
      } finally {
        setState((s) => ({ ...s, busy: false, stage: "" }));
      }
    },
    [state.busy, fileFromResult, setStage, track],
  );

  /** 把某张图片结果转成 3D 模型。 */
  const continueTo3D = useCallback(
    async (item: ResultItem) => {
      if (state.busy) return;
      try {
        setState((s) => ({ ...s, busy: true, error: null, stage: "生成 3D…(约 1-3 分钟)" }));
        const file = await fileFromResult(item);
        const up = await uploadImage(file, "threed");
        const res = await generate3D({
          image: up.filename,
          worker: up.worker,
          steps: 30,
          cfg: 5,
          octree_resolution: 256,
        });
        await track(res, "model3d", item.prompt);
      } catch (e) {
        setState((s) => ({ ...s, error: (e as Error).message }));
      } finally {
        setState((s) => ({ ...s, busy: false, stage: "" }));
      }
    },
    [state.busy, fileFromResult, track],
  );

  return {
    ...state,
    run,
    fileFromResult,
    continueToVideo,
    continueTo3D,
    dismissError: () => setState((s) => ({ ...s, error: null })),
  };
}
