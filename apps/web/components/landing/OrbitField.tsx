"use client";

/** 背景模型环绕轨道 —— ToIV 真实模型在旋转圆环上漂浮(仿 OPC 星空模型图腾)。
   环整体旋转,芯片内层反向等速旋转以保持文字正立;低透明度,纯装饰不抢焦点。 */

const RINGS: { rev?: boolean; dur: number; r: number; models: string[] }[] = [
  {
    dur: 150,
    r: 21,
    models: ["FLUX.2", "Qwen-Image", "Z-Image", "SDXL", "NoobAI", "Illustrious", "Pony", "Animagine"],
  },
  {
    rev: true,
    dur: 210,
    r: 33,
    models: ["Wan 2.2", "LatentSync", "Hunyuan3D", "SUPIR", "ControlNet", "IPAdapter", "KenBurns", "RealESRGAN"],
  },
  {
    dur: 270,
    r: 45,
    models: ["IndexTTS2", "ACE-Step", "Whisper", "PuLID", "FaceDetailer", "Inpaint", "Upscale", "VAE"],
  },
];

export function OrbitField() {
  return (
    <div className="lp-orbit" aria-hidden="true">
      {RINGS.map((ring, ri) => (
        <div
          key={ri}
          className={`lp-ring${ring.rev ? " lp-ring--rev" : ""}`}
          style={{ ["--dur" as string]: `${ring.dur}s` }}
        >
          {ring.models.map((m, mi) => (
            <span
              key={m}
              className="lp-chip"
              style={{
                ["--a" as string]: `${(mi / ring.models.length) * 360}deg`,
                ["--r" as string]: `${ring.r}vw`,
              }}
            >
              <span className="lp-chip-keep">
                <span className="lp-chip-dot" />
                {m}
              </span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
