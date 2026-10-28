import { redirect } from "next/navigation";

/**
 * W2 F2：旧 web 短剧播放页退役。
 * 带 id → studio 短剧单轨 create 工作区（?project=）。
 */
export default async function DramaLegacyRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/studio/create?project=${encodeURIComponent(id)}`);
}
