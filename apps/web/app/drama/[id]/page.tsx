import { redirect } from "next/navigation";

/**
 * W3 F18：旧 web 短剧播放页退役。
 * 强制进 studio 短剧单轨（列表）；完整 ?project= 单轨留给 W2。
 */
export default async function DramaLegacyRedirect({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const resolved = await Promise.resolve(params);
  const id = resolved?.id?.trim();
  // 有 id 时仍进短剧列表（W2 再迁 create?project=）；禁止旧播放器直达
  void id;
  redirect("/studio/toiv/drama");
}
