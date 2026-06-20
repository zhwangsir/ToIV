import type { ModelsResponse, Txt2ImgParams } from "@/lib/types";

interface Props {
  params: Txt2ImgParams;
  models: ModelsResponse | null;
  busy: boolean;
  seedInput: string;
  onPatch: (patch: Partial<Txt2ImgParams>) => void;
  onSeedInput: (value: string) => void;
  onSubmit: () => void;
}

const SIZES = [512, 640, 768, 1024];

export function PromptForm({
  params,
  models,
  busy,
  seedInput,
  onPatch,
  onSeedInput,
  onSubmit,
}: Props) {
  const canSubmit = params.positive.trim().length > 0 && !busy;

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

      <div className="field">
        <label htmlFor="positive">提示词</label>
        <textarea
          id="positive"
          placeholder="描述你想要的画面，例如：a cute corgi puppy on grass, masterpiece"
          value={params.positive}
          onChange={(e) => onPatch({ positive: e.target.value })}
          rows={4}
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
        <label>
          尺寸
          <span className="hint">
            {params.width} × {params.height}
          </span>
        </label>
        <div className="row-2">
          <select
            aria-label="宽"
            value={params.width}
            onChange={(e) => onPatch({ width: Number(e.target.value) })}
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                宽 {s}
              </option>
            ))}
          </select>
          <select
            aria-label="高"
            value={params.height}
            onChange={(e) => onPatch({ height: Number(e.target.value) })}
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                高 {s}
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
          value={params.steps}
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
        {busy ? "生成中…" : "生成"}
      </button>
    </form>
  );
}
