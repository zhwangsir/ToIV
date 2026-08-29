/**
 * txt2img 引用主体封面 → img2img(对齐 H3 t2v→i2v 封面路径,2026-08-30)。
 *
 * 文生图引擎无 images 槽,选中带封面的主体时不能只注入 prompt_hint。
 * 有封面且未上传参考图:切到对应 img2img 并把封面当输入;无封面保持文生。
 * 历史 engineId 仍用所选文生引擎,失败重试走同一条封面→img2img 路径。
 */

export function isTxt2imgEngine(engineId: string): boolean {
  return engineId === "txt2img" || engineId === "nsfw-txt2img";
}

/** 文生图引擎 → 对应图生图(nsfw 对齐);非文生图返回 null。 */
export function img2imgPartnerId(engineId: string): "img2img" | "nsfw-img2img" | null {
  if (engineId === "txt2img") return "img2img";
  if (engineId === "nsfw-txt2img") return "nsfw-img2img";
  return null;
}

/**
 * payload 走了 img2img:提交引擎已是图生,或 txt2img 带着参考图/封面提交。
 * 与 h3PayloadWentI2v 同形,供历史文案与重试判断。
 */
export function txt2imgPayloadWentImg2img(opts: {
  engineId: string;
  submittedEngineId?: string | null;
  hasRefImage?: boolean;
}): boolean {
  if (!isTxt2imgEngine(opts.engineId)) return false;
  const submitted = opts.submittedEngineId ?? "";
  if (submitted === "img2img" || submitted === "nsfw-img2img") return true;
  return Boolean(opts.hasRefImage);
}

/**
 * 提交后历史/进度条文案。wentImg2img 时显示图生,但 engineId 仍用所选引擎,
 * 方便失败重试走同一条封面→img2img 路径(改成 img2img 会因缺参考图槽失败)。
 */
export function txt2imgHistoryPresentation(
  engine: { id: string; label: string },
  opts: { wentImg2img: boolean },
): { engineId: string; engineLabel: string } {
  if (!opts.wentImg2img) return { engineId: engine.id, engineLabel: engine.label };
  if (engine.id === "txt2img") return { engineId: engine.id, engineLabel: "图生图" };
  if (engine.id === "nsfw-txt2img") return { engineId: engine.id, engineLabel: "图生图(R18)" };
  return { engineId: engine.id, engineLabel: engine.label };
}
