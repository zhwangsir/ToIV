#!/usr/bin/env python3
"""
ToIV 开发心跳监控系统
每10分钟自动执行一次，监控开发进度、任务完成情况、潜在阻碍
生成进度报告存储到 .heartbeat/reports/ 目录
"""

import json
import os
import subprocess
import sys
import time
import socket
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
REPORTS_DIR = PROJECT_ROOT / ".heartbeat" / "reports"
STATE_FILE = PROJECT_ROOT / "STATE.json"
HEARTBEAT_STATE_FILE = PROJECT_ROOT / ".heartbeat" / "heartbeat_state.json"
INTERVAL_SECONDS = 600

os.makedirs(REPORTS_DIR, exist_ok=True)


def load_json(path: Path, default: Any = None) -> Any:
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def save_json(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run_cmd(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)


def check_port(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except Exception:
        return False


def get_git_status() -> dict[str, Any]:
    code, out, err = run_cmd(["git", "status", "--porcelain"], cwd=PROJECT_ROOT, timeout=10)
    modified = []
    untracked = []
    if code == 0:
        for line in out.strip().split("\n"):
            if not line.strip():
                continue
            status = line[:2]
            fname = line[3:].strip()
            if status == "??":
                untracked.append(fname)
            else:
                modified.append(fname)

    code2, last_commit_out, _ = run_cmd(
        ["git", "log", "-1", "--pretty=format:%h|%s|%ai"], cwd=PROJECT_ROOT, timeout=10
    )
    last_commit = None
    if code2 == 0 and last_commit_out:
        parts = last_commit_out.split("|", 2)
        if len(parts) == 3:
            last_commit = {"hash": parts[0], "subject": parts[1], "date": parts[2]}

    code3, branch_out, _ = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=PROJECT_ROOT, timeout=5)
    branch = branch_out.strip() if code3 == 0 else "unknown"

    return {
        "branch": branch,
        "modified_count": len(modified),
        "untracked_count": len(untracked),
        "modified_files": modified[:20],
        "untracked_files": untracked[:20],
        "last_commit": last_commit,
    }


def check_services() -> dict[str, Any]:
    services = {
        "web_dev": {"port": 3101, "host": "localhost", "name": "前端开发服务器"},
        "api_dev": {"port": 8090, "host": "localhost", "name": "后端API服务"},
        "api_prod": {"port": 8090, "host": "192.168.71.127", "name": "后端(Workstation)"},
        "web_prod": {"port": 3100, "host": "192.168.71.127", "name": "前端(Workstation)"},
        "sglang_l1": {"port": 8000, "host": "192.168.71.127", "name": "L1 SGLang (qwen3.6)"},
        "exo_l23": {"port": 52415, "host": "192.168.71.109", "name": "L2/L3 EXO集群"},
        "vllm_l4": {"port": 8000, "host": "192.168.71.82", "name": "L4 vLLM (euryale-70b)"},
        "tts": {"port": 9200, "host": "192.168.71.127", "name": "TTS服务 (IndexTTS2)"},
        "comfyui_lb": {"port": 8188, "host": "192.168.71.127", "name": "ComfyUI负载均衡"},
    }
    results = {}
    for key, svc in services.items():
        results[key] = {
            "name": svc["name"],
            "online": check_port(svc["host"], svc["port"]),
            "host": svc["host"],
            "port": svc["port"],
        }
    return results


def analyze_roadmap(state: dict[str, Any]) -> dict[str, Any]:
    roadmap = state.get("roadmap", {})
    analysis = {"phases": [], "blockers": [], "warnings": []}

    phase_meta = [
        ("A_base_model_upgrade", "A期：底模升级 (SD1.5→Qwen/FLUX/Z-Image)"),
        ("B_eval_prompt_pipeline", "B期：评估与提示词流水线"),
        ("C_audio_upgrade", "C期：音频升级"),
        ("D_finetune", "D期：微调"),
        ("E_data_flywheel", "E期：数据飞轮"),
    ]

    completed_recent = state.get("recent_completed", [])
    last_milestone = completed_recent[0] if completed_recent else None

    for key, label in phase_meta:
        phase = roadmap.get(key, {})
        status = phase.get("status", "not_started")
        analysis["phases"].append({
            "key": key,
            "label": label,
            "status": status,
            "evidence": phase.get("evidence", ""),
        })
        if status == "in_progress_uncommitted":
            analysis["warnings"].append(f"[{label}] 存在未提交改动")

    if last_milestone:
        analysis["last_milestone"] = last_milestone[:120] + "..." if len(last_milestone) > 120 else last_milestone

    return analysis


def detect_blockers(git: dict[str, Any], services: dict[str, Any], state: dict[str, Any]) -> list[dict[str, str]]:
    blockers = []
    warnings = []

    total_uncommitted = git["modified_count"] + git["untracked_count"]
    if total_uncommitted > 30:
        warnings.append({
            "level": "warning",
            "category": "git",
            "message": f"未提交改动较多（{git['modified_count']} modified + {git['untracked_count']} untracked = {total_uncommitted}个文件），建议及时提交",
        })

    critical_services = ["web_dev", "api_dev"]
    for sk in critical_services:
        svc = services.get(sk, {})
        if not svc.get("online"):
            blockers.append({
                "level": "blocker" if sk == "api_dev" else "warning",
                "category": "service",
                "message": f"{svc.get('name', sk)} 未运行 ({svc.get('host')}:{svc.get('port')})",
            })

    model_services = ["sglang_l1", "vllm_l4", "tts"]
    offline_models = [services[s]["name"] for s in model_services if s in services and not services[s]["online"]]
    if offline_models:
        warnings.append({
            "level": "warning",
            "category": "infra",
            "message": f"部分模型服务离线: {', '.join(offline_models)}",
        })

    health = state.get("health", {})
    for hk, hv in health.items():
        if isinstance(hv, dict) and hv.get("status") == "failed":
            blockers.append({
                "level": "blocker",
                "category": "health",
                "message": f"{hk} 检查失败: {hv.get('note', '')[:80]}",
            })

    return blockers + warnings


def calculate_progress_delta(prev_state: dict[str, Any], current_state: dict[str, Any]) -> dict[str, Any]:
    if not prev_state:
        return {"first_run": True, "completed_milestones": 0, "health_changes": []}

    prev_completed = len(prev_state.get("recent_completed", []))
    curr_completed = len(current_state.get("recent_completed", []))
    new_milestones = curr_completed - prev_completed

    prev_health = prev_state.get("health", {})
    curr_health = current_state.get("health", {})
    health_changes = []
    for key in set(list(prev_health.keys()) + list(curr_health.keys())):
        prev_s = prev_health.get(key, {}).get("status", "unknown")
        curr_s = curr_health.get(key, {}).get("status", "unknown")
        if prev_s != curr_s:
            health_changes.append({"check": key, "from": prev_s, "to": curr_s})

    return {
        "first_run": False,
        "new_milestones": new_milestones,
        "health_changes": health_changes,
    }


def generate_report(
    timestamp: datetime,
    state: dict[str, Any],
    git: dict[str, Any],
    services: dict[str, Any],
    roadmap: dict[str, Any],
    blockers: list[dict[str, str]],
    delta: dict[str, Any],
    hb_state: dict[str, Any],
) -> str:
    ts_str = timestamp.strftime("%Y-%m-%d %H:%M:%S")
    date_str = timestamp.strftime("%Y-%m-%d")
    time_str = timestamp.strftime("%H%M")

    overall_status = "✅ 正常"
    p0_blockers = [b for b in blockers if b["level"] == "blocker"]
    if p0_blockers:
        overall_status = "🔴 有阻塞"
    elif blockers:
        overall_status = "🟡 有警告"

    health = state.get("health", {})
    online_services = sum(1 for s in services.values() if s["online"])
    total_services = len(services)

    lines = []
    lines.append(f"# ToIV 开发心跳报告")
    lines.append(f"")
    lines.append(f"**时间**: {ts_str}")
    lines.append(f"**总体状态**: {overall_status}")
    lines.append(f"**运行序号**: {hb_state.get('beat_count', 1)}")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"")

    lines.append(f"## 一、快速概览")
    lines.append(f"")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|-----|-----|")
    lines.append(f"| Git分支 | {git['branch']} |")
    lines.append(f"| 未提交改动 | {git['modified_count']} modified, {git['untracked_count']} untracked |")
    lines.append(f"| 最近提交 | {git['last_commit']['hash'][:8] if git['last_commit'] else 'N/A'} - {git['last_commit']['subject'][:50] if git['last_commit'] else ''} |")
    lines.append(f"| 服务在线 | {online_services}/{total_services} |")
    lines.append(f"| 里程碑总数 | {len(state.get('recent_completed', []))} |")
    lines.append(f"| 后端测试 | {health.get('api_pytest', {}).get('status', 'unknown')} ({health.get('api_pytest', {}).get('total', '?')} passed) |")
    lines.append(f"| 前端TS检查 | {health.get('web_tsc', {}).get('status', 'unknown')} |")
    lines.append(f"| 前端构建 | {health.get('web_build', {}).get('status', 'unknown')} |")
    lines.append(f"")

    if not delta.get("first_run"):
        lines.append(f"### 本次间隔进展")
        lines.append(f"")
        if delta.get("new_milestones", 0) > 0:
            lines.append(f"- ✅ 新增 {delta['new_milestones']} 个里程碑完成")
        if delta.get("health_changes"):
            for ch in delta["health_changes"]:
                arrow = "↗️" if ch["to"] == "passed" else "↘️"
                lines.append(f"- {arrow} `{ch['check']}`: {ch['from']} → {ch['to']}")
        if delta.get("new_milestones", 0) == 0 and not delta.get("health_changes"):
            lines.append(f"- ⏸️ 本次心跳间隔无明显变化")
        lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    lines.append(f"## 二、路线图进度")
    lines.append(f"")
    lines.append(f"| 阶段 | 状态 | 备注 |")
    lines.append(f"|-----|------|------|")
    status_emoji = {
        "completed": "✅",
        "in_progress": "🔵",
        "in_progress_uncommitted": "🟡",
        "partial": "🟡",
        "not_started": "⚪",
    }
    for phase in roadmap["phases"]:
        emoji = status_emoji.get(phase["status"], "❓")
        lines.append(f"| {emoji} {phase['label']} | {phase['status']} | {phase['evidence']} |")
    lines.append(f"")

    if roadmap.get("last_milestone"):
        lines.append(f"**最近完成**: {roadmap['last_milestone']}")
        lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    lines.append(f"## 三、基础设施状态")
    lines.append(f"")
    lines.append(f"| 服务 | 状态 | 地址 |")
    lines.append(f"|-----|------|------|")
    for sk, svc in services.items():
        emoji = "✅" if svc["online"] else "❌"
        lines.append(f"| {emoji} {svc['name']} | {'在线' if svc['online'] else '离线'} | {svc['host']}:{svc['port']} |")
    lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    lines.append(f"## 四、问题与阻碍")
    lines.append(f"")
    if not blockers:
        lines.append(f"✅ 无阻塞或警告")
    else:
        for b in blockers:
            icon = "🔴" if b["level"] == "blocker" else "🟡"
            lines.append(f"- {icon} **[{b['category']}]** {b['message']}")
    lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    lines.append(f"## 五、Git 工作区状态")
    lines.append(f"")
    if git["modified_files"]:
        lines.append(f"**Modified files** (showing up to 20):")
        lines.append(f"```")
        for f in git["modified_files"]:
            lines.append(f"  M {f}")
        lines.append(f"```")
        lines.append(f"")
    if git["untracked_files"]:
        lines.append(f"**Untracked files** (showing up to 20):")
        lines.append(f"```")
        for f in git["untracked_files"]:
            lines.append(f"  ?? {f}")
        lines.append(f"```")
        lines.append(f"")

    lines.append(f"---")
    lines.append(f"")
    lines.append(f"*下次心跳: 约10分钟后 | 监控脚本: scripts/dev_heartbeat.py*")

    return "\n".join(lines)


def run_heartbeat():
    now = datetime.now()
    print(f"[{now.strftime('%Y-%m-%d %H:%M:%S')}] 💓 ToIV 开发心跳启动...")

    state = load_json(STATE_FILE, {})
    hb_state = load_json(HEARTBEAT_STATE_FILE, {
        "beat_count": 0,
        "first_start": now.isoformat(),
        "last_report": None,
        "prev_state_snapshot": None,
    })

    hb_state["beat_count"] = hb_state.get("beat_count", 0) + 1
    prev_state = hb_state.get("prev_state_snapshot")

    print(f"  → 检查 Git 状态...")
    git = get_git_status()

    print(f"  → 检查服务连通性...")
    services = check_services()

    print(f"  → 分析路线图...")
    roadmap = analyze_roadmap(state)

    print(f"  → 检测阻塞因素...")
    blockers = detect_blockers(git, services, state)
    for w in roadmap.get("warnings", []):
        blockers.append({"level": "warning", "category": "roadmap", "message": w})

    print(f"  → 计算进度偏差...")
    delta = calculate_progress_delta(prev_state or {}, state)

    print(f"  → 生成报告...")
    report = generate_report(now, state, git, services, roadmap, blockers, delta, hb_state)

    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H%M%S")
    report_dir = REPORTS_DIR / date_str
    os.makedirs(report_dir, exist_ok=True)
    report_file = report_dir / f"heartbeat_{time_str}.md"
    with open(report_file, "w", encoding="utf-8") as f:
        f.write(report)

    latest_file = REPORTS_DIR / "LATEST.md"
    with open(latest_file, "w", encoding="utf-8") as f:
        f.write(report)

    hb_state["last_report"] = str(report_file)
    hb_state["last_beat_time"] = now.isoformat()
    hb_state["prev_state_snapshot"] = state
    save_json(HEARTBEAT_STATE_FILE, hb_state)

    p0_count = sum(1 for b in blockers if b["level"] == "blocker")
    warn_count = sum(1 for b in blockers if b["level"] == "warning")
    print(f"[{now.strftime('%Y-%m-%d %H:%M:%S')}] ✅ 心跳 #{hb_state['beat_count']} 完成")
    print(f"  → 报告: {report_file}")
    print(f"  → 阻塞: {p0_count} | 警告: {warn_count} | 服务在线: {sum(1 for s in services.values() if s['online'])}/{len(services)}")
    print(f"  → 下次运行: 10分钟后")
    print()

    return 0


def main():
    print("=" * 60)
    print("ToIV 开发心跳监控系统")
    print(f"间隔: {INTERVAL_SECONDS}秒 (10分钟)")
    print(f"报告目录: {REPORTS_DIR}")
    print("=" * 60)
    print()

    run_heartbeat()

    while True:
        time.sleep(INTERVAL_SECONDS)
        try:
            run_heartbeat()
        except KeyboardInterrupt:
            print("\n心跳监控已停止")
            sys.exit(0)
        except Exception as e:
            print(f"心跳执行异常: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(60)


if __name__ == "__main__":
    main()
