import { redirect } from "next/navigation";

// 登录表单在带查询串的产品首页(裸 "/" 已是官网落地页,见 middleware.ts)
export default function LoginPage() {
  redirect("/?view=home");
}
