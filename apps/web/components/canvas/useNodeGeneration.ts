"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  generate3D,
  generateAudio,
  generateControlNet,
  generateImg2img,
  generateTxt2img,
  generateTxt2video,
  generateVideo,
  imageUrl,
  jobEventsUrl,
  renderManjuShot,
  uploadImage,
} from "@/lib/api";
import type { GenerateResponse } from "@/lib/types";

/** 一次节点生成的派发载荷(画布侧高层节点 → 底层 api)。 */
export type NodeDispatch =
  | { kind: "txt2img"; positive: string; ckpt: string; width: number; height: number }
  | {
      kind: "img2img";
      positive: string;
      ckpt: string;
      image: string;
      worker: string;
      denoise: number;
    }
  | {
      kind: "controlnet";
      positive: string;
      ckpt: string;
      image: string;
      worker: string;
      controlType: string;
      strength: number;
    }
  | {
      kind: "ipadapter";
      positive: string;
      ckpt: string;
      image: string;
      worker: string;
      weight: number;
    }
  | { kind: "txt2video"; positive: string; width: number; height: number; length: number; fps: number }
  | {
      kind: "i2v";
      positive: string;
      image: string;
      worker: string;
      width: number;
      height: number;
      length: number;
      fps: number;
    }
  | { kind: "audio"; tags: string; seconds: number }
  | {
      kind: "threed";
      image: string;
      worker: string;
      steps: number;
      octree: number;
    };

/** 生成结果:产物 URL + 画幅(供下游沿用比例)。 */
export interface GenOutput {
  url: string;
  width?: number;
  height?: number;
}

/** 节点向外汇报运行态的回调。 */
export interface RunReporter {
  onStage: (stage: string, progress: number | null) => void;
  onDone: (out: GenOutput) => void;
  onError: (message: string) => void;
}

async function submit(d: NodeDispatch): Promise<GenerateResponse> {
  switch (d.kind) {
    case "txt2img":
      return generateTxt2img({
        positive: d.positive,
        negative: "blurry, lowres, deformed, watermark, text, extra limbs",
        ckpt_name: d.ckpt,
        width: d.width,
        height: d.height,
        steps: 20,
        cfg: 7,
        sampler: "euler",
        scheduler: "normal",
      });
    case "img2img":
      return generateImg2img({
        positive: d.positive || "enhance, high quality, detailed",
        negative: "blurry, lowres, deformed, watermark, text, extra limbs",
        ckpt_name: d.ckpt,
        image: d.image,
        worker: d.worker,
        denoise: d.denoise,
        steps: 20,
        cfg: 7,
        sampler: "euler",
        scheduler: "normal",
      });
    case "controlnet":
      return generateControlNet({
        positive: d.positive,
        negative: "blurry, lowres, deformed, watermark, text, extra limbs",
        ckptName: d.ckpt,
        image: d.image,
        worker: d.worker,
        controlType: d.controlType,
        strength: d.strength,
      });
    case "ipadapter":
      return renderManjuShot({
        positive: d.positive,
        worker: d.worker,
        characterRef: d.image,
        ckptName: d.ckpt,
        weight: d.weight,
      });
    case "txt2video":
      return generateTxt2video({
        positive: d.positive || "cinematic motion, smooth camera",
        negative: "blurry, lowres, deformed, watermark, text",
        width: d.width,
        height: d.height,
        length: d.length,
        fps: d.fps,
      });
    case "i2v":
      return generateVideo({
        positive: d.positive || "subtle natural motion, cinematic",
        image: d.image,
        worker: d.worker,
        width: d.width,
        height: d.height,
        length: d.length,
        fps: d.fps,
      });
    case "audio":
      return generateAudio({ tags: d.tags, lyrics: "", seconds: d.seconds });
    case "threed":
      return generate3D({
        image: d.image,
        worker: d.worker,
        steps: d.steps,
        cfg: 5,
        octree_resolution: d.octree,
      });
  }
}

/** 把 [url] 拉成 File(供把上游图片产物转成图生视频/图生图入参)。 */
export async function urlToFile(url: string): Promise<File> {
  const blob = await (await fetch(url)).blob();
  return new File([blob], "ref.png", { type: blob.type || "image/png" });
}

/** 把图片产物 URL 上传到指定 worker,得到 {filename, worker}。 */
export async function uploadFromUrl(
  url: string,
  kind: string,
): Promise<{ filename: string; worker: string }> {
  const file = await urlToFile(url);
  return uploadImage(file, kind);
}

/**
 * 单节点生成引擎:提交 → SSE 追踪 → 回调汇报。
 * 与 create/useGenerationFeed 同一范式(jobEventsUrl + EventSource),
 * 但按节点粒度返回 Promise,便于「运行全部」按拓扑顺序串行 await。
 */
export function useNodeGeneration() {
  const esSet = useRef<Set<EventSource>>(new Set());

  useEffect(
    () => () => {
      esSet.current.forEach((es) => es.close());
      esSet.current.clear();
    },
    [],
  );

  const track = useCallback(
    (
      res: GenerateResponse,
      rep: RunReporter,
      hintW?: number,
      hintH?: number,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        const es = new EventSource(
          jobEventsUrl(res.prompt_id, res.client_id, res.worker),
        );
        esSet.current.add(es);
        let done = false;

        const cleanup = () => {
          es.close();
          esSet.current.delete(es);
        };

        es.addEventListener("progress", (e) => {
          try {
            const d = JSON.parse((e as MessageEvent).data);
            if (d.max > 0) {
              const pct = Math.min(100, Math.round((d.value / d.max) * 100));
              rep.onStage(`采样中 ${d.value}/${d.max} 步`, pct);
            }
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
          const first = paths[0];
          if (first) {
            rep.onDone({ url: imageUrl(first), width: hintW, height: hintH });
          } else {
            rep.onError("生成完成但没有产物");
          }
          cleanup();
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
            rep.onError(msg);
            cleanup();
            resolve();
          } else if (!done) {
            rep.onError("与服务器连接中断");
            cleanup();
            resolve();
          }
        });
      }),
    [],
  );

  /** 派发一次生成并跟踪到产物。出错通过 reporter 上报,不抛。 */
  const generate = useCallback(
    async (d: NodeDispatch, rep: RunReporter): Promise<void> => {
      try {
        const res = await submit(d);
        const w = "width" in d ? d.width : undefined;
        const h = "height" in d ? d.height : undefined;
        await track(res, rep, w, h);
      } catch (e) {
        rep.onError((e as Error).message);
      }
    },
    [track],
  );

  return { generate };
}
