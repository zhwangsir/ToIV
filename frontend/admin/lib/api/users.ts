import { apiFetch, authHeaders, raiseApiError } from "./http";
import type { AdminUser } from "../types";

export async function listUsers(): Promise<AdminUser[]> {
  const res = await apiFetch(`/api/admin/users`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载用户失败 (${res.status})`);
  return res.json();
}

export async function createUser(
  email: string,
  password: string,
  role: string,
): Promise<AdminUser> {
  const res = await apiFetch(`/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email, password, role }),
  });
  if (!res.ok) await raiseApiError(res, "创建账号失败");
  return res.json();
}

export async function deleteUser(id: string): Promise<void> {
  const res = await apiFetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除失败");
}
