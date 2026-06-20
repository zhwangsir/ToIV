import type { GenMode, ModelsResponse, Txt2ImgParams } from "@/lib/types";

interface Props {
  params: Txt2ImgParams;
  models: ModelsResponse | null;
  busy: boolean;
  seedInput: string;
  mode: GenMode;
  denoise: number;
  imagePreview: string | null;
  onModeChange: (mode: GenMode) => void;
  onImageChange: (file: File | null) => void;
  onDenoise: (v: number) => void;
  onPatch: (patch: Partial<Txt2ImgParams>) => void;
  onSeedInput: (value: string) => void;
  onSubmit: () => void;
}

const ASPECTS = [
  { key: "1:1", w: 512, h: 512, label: "1:1" },
  { key: "2:3", w: 512, h: 768, label: "2:3" },
  { key: "3:2", w: 768, h: 512, label: "3:2" },
  { key: "hd", w: 768, h: 768, label: "大图" },
];

function pct(value: number, min: number, max: number): string {
  return `${((value - min) / (max - min)) * 100}%`;
}

export function PromptForm({
  params,
  models,
  busy,
  seedInput,
  mode,
  denoise,
  imagePreview,
  onModeChange,
  onImageChange,
  onDenoise,
  onPatch,
  onSeedInput,
  onSubmit,
}: Props) {
  const needsImage = mode === "img2img" && !imagePreview;
  const canSubmit = params.positive.trim().length > 0 && !needsImage && !busy;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div className="panel-head">
        <span className="accent" aria-hidden="true" />
        创作参数
      </div>

      <div className="seg seg-2" role="group" aria-label="生成模式">
        <button
          type="button"
          className={mode === "txt2img" ? "active" : ""}
          onClick={() => onModeChange("txt2img")}
        >
          文生图
        </button>
        <button
          type="button"
          className={mode === "img2img" ? "active" : ""}
          onClick={() => onModeChange("img2img")}
        >
          图生图
        </button>
      </div>

      {mode === "img2img" && (
        <div className="field">
          <label>源图</label>
          <label className="dropzone">
            {imagePreview ? (
              <img src={imagePreview} alt="源图预览" />
            ) : (
              <span>点击上传图片</span>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onImageChange(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      )}

      <div className="field">
        <label htmlFor="positive">
          提示词
          <span className="hint">{params.positive.length}</span>
        </label>
        <textarea
          id="positive"
          placeholder={
            mode === "img2img"
              ? "描述你想把图片变成什么样"
              : "描述你想要的画面，例如：a cute corgi puppy on grass, masterpiece"
          }
          value={params.positive}
          onChange={(e) => onPatch({ positive: e.target.value })}
          rows={3}
        />
      </div>

      <div className="field">
        <label htmlFor="negative">负面提示词</label>
        <textarea
          id="negative"
          placeholder="不想出现的元素，例如：blurry, lowres, deformed"
          value={params.negative}
          onChange={(e) => onPatch({ negative: e.target.value })}
          rows={2}
        />
      </div>

      <div className="field">
        <label htmlFor="ckpt">模型</label>
        <select
          id="ckpt"
          value={params.ckpt_name}
          onChange={(e) => onPatch({ ckpt_name: e.target.value })}
        >
          {(models?.checkpoints ?? [params.ckpt_name]).map((c) => (
            <option key={c} value={c}>
              {c.replace(/\.safetensors$/, "")}
            </option>
          ))}
        </select>
      </div>

      {mode === "txt2img" ? (
        <div className="field">
          <label>
            画幅比例
            <span className="hint">
              {params.width} × {params.height}
            </span>
          </label>
          <div className="seg" role="group" aria-label="画幅比例">
            {ASPECTS.map((a) => (
              <button
                key={a.key}
                type="button"
                className={params.width === a.w && params.height === a.h ? "active" : ""}
                onClick={() => onPatch({ width: a.w, height: a.h })}
              >
                <span
                  className="glyph"
                  style={{
                    width: 16 * (a.w / Math.max(a.w, a.h)),
                    height: 16 * (a.h / Math.max(a.w, a.h)),
                  }}
                  aria-hidden="true"
                />
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="denoise">
            重绘强度 <span className="hint">{denoise.toFixed(2)}</span>
          </label>
          <input
            id="denoise"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={denoise}
            style={{ ["--pct" as string]: pct(denoise, 0.1, 1) }}
            onChange={(e) => onDenoise(Number(e.target.value))}
          />
        </div>
      )}

      <div className="row-2">
        <div className="field">
          <label htmlFor="sampler">采样器</label>
          <select
            id="sampler"
            value={params.sampler}
            onChange={(e) => onPatch({ sampler: e.target.value })}
          >
            {(models?.samplers ?? [params.sampler]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="scheduler">调度器</label>
          <select
            id="scheduler"
            value={params.scheduler}
            onChange={(e) => onPatch({ scheduler: e.target.value })}
          >
            {(models?.schedulers ?? [params.scheduler]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="steps">
          步数 <span className="hint">{params.steps}</span>
        </label>
        <input
          id="steps"
          type="range"
          min={1}
          max={50}
          step={1}
          value={params.steps}
          style={{ ["--pct" as string]: pct(params.steps, 1, 50) }}
          onChange={(e) => onPatch({ steps: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label htmlFor="cfg">
          CFG <span className="hint">{params.cfg.toFixed(1)}</span>
        </label>
        <input
          id="cfg"
          type="range"
          min={1}
          max={20}
          step={0.5}
          value={params.cfg}
          style={{ ["--pct" as string]: pct(params.cfg, 1, 20) }}
          onChange={(e) => onPatch({ cfg: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label htmlFor="seed">
          种子 <span className="hint">留空 = 随机</span>
        </label>
        <input
          id="seed"
          type="text"
          inputMode="numeric"
          placeholder="随机"
          value={seedInput}
          onChange={(e) => onSeedInput(e.target.value.replace(/[^0-9]/g, ""))}
        />
      </div>

      <button type="submit" className="generate-btn" disabled={!canSubmit}>
        {busy ? "生成中…" : needsImage ? "请先上传图片" : "生成"}
      </button>
    </form>
  );
}
