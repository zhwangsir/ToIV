"use client";

import { API_BASE, authHeaders } from "./api";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  node_count: number;
  filename: string;
}

export interface DeployResult {
  worker_url: string;
  workflow_name: string;
  load_url: string;
  template_id: string;
}

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const res = await fetch(`${API_BASE}/api/workflows/templates`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("获取工作流模板失败");
  const data = (await res.json()) as { templates: WorkflowTemplate[] };
  return data.templates ?? [];
}

export async function deployWorkflowTemplate(id: string): Promise<DeployResult> {
  const res = await fetch(`${API_BASE}/api/workflows/${id}/deploy`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `部署工作流失败: ${res.status}`);
  }
  return (await res.json()) as DeployResult;
}

export function downloadWorkflowTemplate(id: string): string {
  return `${API_BASE}/api/workflows/${id}/download`;
}

export const DEFAULT_COMFYUI_URL = "http://192.168.71.100:8000";

export function getStoredComfyUrl(): string {
  if (typeof window === "undefined") return DEFAULT_COMFYUI_URL;
  return localStorage.getItem("toiv_comfyui_url") || DEFAULT_COMFYUI_URL;
}

export function setStoredComfyUrl(url: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("toiv_comfyui_url", url);
}
