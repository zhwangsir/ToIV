import { redirect } from "next/navigation";

/**
 * W2 F2 / W6：旧 web 短剧播放页退役。
 * 带 id → Prime /studio?project=（唯一创作入口；勿再指 /studio/create）。
 */
export default async function DramaLegacyRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/studio?project=${encodeURIComponent(id)}`);
}
