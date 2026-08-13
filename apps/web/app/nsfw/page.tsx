import { redirect } from "next/navigation";

// M9:NSFW 专区已整合进主站(R18 全局内容模式,设置页开关),旧链接重定向首页不 404
export default function NsfwPage() {
  redirect("/");
}
