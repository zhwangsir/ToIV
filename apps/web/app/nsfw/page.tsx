import { NsfwView } from "@/components/nsfw/NsfwView";

// 隐藏专页:仅通过 /nsfw 直达,不出现在主导航
export default function NsfwPage() {
  return <NsfwView />;
}
