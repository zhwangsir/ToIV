#!/usr/bin/env python3
"""设备远程访问能力检查脚本。

基于 tailscale status --json 获取真实在线状态与 Tailscale IP,
测试 tailscale ping(非本地局域网访问)与经 Tailscale 的 SSH 可达性,
同时保留 LAN ping 测试(若本机在局域网),并补充公网入口抽检。
用法: python3 scripts/device_connectivity_check.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

# Tailscale DNSName 第一段 → (用户名, LAN IP) 映射。
# 以 DNSName 为键是因为 Tailscale 的 HostName 可能带本地化显示名(如 "dgmt-studio01的Mac Studio"),
# 而 DNSName 稳定可预测。
DEVICE_MAP = {
    "dgmt-studio01mac-studio": ("dgmt-studio01", "192.168.71.109"),
    "dgmt-studio02mac-studio": ("dgmt-studio02", "192.168.71.111"),
    "dgmt-studio03mac-studio": ("dgmt-studio03", "192.168.71.112"),
    "dgmt-studio04mac-studio": ("dgmt-studio04", "192.168.71.113"),
    "openclaw01-1": ("dgmt-openclaw01", "192.168.71.86"),
    "dgmt-openclaw02demac-mini-1": ("dgmt-openclaw02", "192.168.71.75"),
    "dgmt-openclaw03demac-mini-1": ("dgmt-openclaw03", "192.168.71.81"),
    "openclaw04-1": ("dgmt-openclaw04", "192.168.71.85"),
    "spark01": ("dgmt-spark", "192.168.71.82"),
    "spark02": ("dgmt-spark", "192.168.71.84"),
    "workstation": ("merlin", "192.168.71.127"),
    "pc01-3": ("home", "192.168.71.115"),
    "pc02": ("w", "192.168.71.114"),
    "nas-dxp8800": ("dgmt-nas", "192.168.71.7"),
    "cloud": ("root", "192.168.71.47"),
    "core": ("merlin", "192.168.71.47"),
}

# 公网入口抽检:名称 → (类型, 目标)
PUBLIC_CHECKS = {
    "cloud-public-ping": ("icmp", "43.119.32.180"),
    "toiv-home": ("https", "https://toiv.dgmt.top/"),
    "toiv-api-health": ("https", "https://toiv.dgmt.top/api/health"),
}


def run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


def canonical_dns_name(dns_name: str | None) -> str:
    """取 DNSName 的第一段并小写,作为稳定设备标识。"""
    if not dns_name:
        return ""
    return dns_name.split(".")[0].lower()


def tailscale_status() -> list[dict]:
    rc, out, _ = run(["tailscale", "status", "--json"], timeout=15)
    if rc != 0:
        print("无法获取 tailscale status:", out, file=sys.stderr)
        sys.exit(1)
    data = json.loads(out)
    peers = []
    self_info = data.get("Self", {})
    self_dns = canonical_dns_name(self_info.get("DNSName", ""))
    peers.append({
        "host": self_dns or "self",
        "display": self_info.get("HostName", "self"),
        "ts_ip": (self_info.get("TailscaleIPs") or [""])[0],
        "online": self_info.get("Online", False),
    })
    for _, v in data.get("Peer", {}).items():
        dns = canonical_dns_name(v.get("DNSName"))
        display = v.get("HostName") or dns or "unknown"
        peers.append({
            "host": dns or display,
            "display": display,
            "ts_ip": (v.get("TailscaleIPs") or [""])[0],
            "online": v.get("Online", False),
        })
    return peers


def ts_ping(ip: str) -> str:
    rc, out, _ = run(["tailscale", "ping", "-c", "1", "--timeout", "8s", ip], timeout=12)
    # tailscale ping 在仅通过 DERP 中转时 rc 可能为 1,但 stdout 仍含 pong 行;只要收到 pong 就算可达。
    if rc != 0 and "pong from" not in out:
        return "FAIL"
    last = out.strip().splitlines()[-1]
    # pong from ... (...): 22.326ms via ...  或 via DERP(sin) in 255ms
    if "pong from" in last:
        for token in last.split():
            if token.endswith("ms"):
                return token.replace("ms", "")
    return "FAIL"


def ts_ssh(user: str, ip: str) -> tuple[str, str]:
    """经 Tailscale 的 SSH 可达性测试。

    不用 ``tailscale ssh`` wrapper(它对 host key 做严格校验且不接受 -o 关闭),
    改用系统 ssh + ``tailscale nc`` ProxyCommand,可稳定跨设备复用。
    """
    if not user:
        return "SKIP", "-"
    t0 = time.time()
    # 跨境/DERP 中转节点首包握手可能超过 5s,ConnectTimeout 给 10s,整体给 45s。
    rc, out, err = run(
        [
            "ssh",
            "-o", f'ProxyCommand=tailscale nc {ip} 22',
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            "-o", "BatchMode=yes",
            f"{user}@{ip}",
            "echo OK",
        ],
        timeout=45,
    )
    dt = f"{int((time.time() - t0) * 1000)}"
    if rc == 0 and out.strip() == "OK":
        return "OK", dt
    # 常见未授权/无 SSH 时也会给出明确反馈,仍算协议可达
    if "Permission denied" in err or "permission denied" in err.lower():
        return "AUTH", dt
    return "FAIL", "-"


def icmp_ping(ip: str) -> str:
    rc, out, _ = run(["ping", "-c", "1", "-W", "2", ip], timeout=5)
    if rc != 0:
        return "FAIL"
    for line in out.splitlines():
        if "/" in line and "round-trip" in line:
            parts = line.split("=")[-1].strip().split("/")
            if len(parts) >= 2:
                return parts[1].strip()
    return "FAIL"


def https_get(url: str) -> tuple[str, str]:
    """返回 (状态码或 FAIL, 响应时间 ms)。"""
    t0 = time.time()
    rc, out, err = run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}|%{time_total}", "--max-time", "15", url],
        timeout=20,
    )
    dt = f"{int((time.time() - t0) * 1000)}"
    if rc != 0:
        return "FAIL", dt
    try:
        code, total = out.strip().split("|")
        return code, f"{int(float(total) * 1000)}"
    except ValueError:
        return "FAIL", dt


def public_checks() -> list[dict]:
    rows = []
    for name, (kind, target) in PUBLIC_CHECKS.items():
        if kind == "icmp":
            status = icmp_ping(target)
            rows.append({
                "device": name,
                "target": target,
                "kind": "icmp",
                "status": status if status == "FAIL" else "OK",
                "latency_ms": status if status != "FAIL" else "-",
            })
        elif kind == "https":
            status, latency = https_get(target)
            rows.append({
                "device": name,
                "target": target,
                "kind": "https",
                "status": status,
                "latency_ms": latency,
            })
    return rows


def main() -> int:
    peers = tailscale_status()
    rows = []
    for peer in peers:
        host = peer["host"]
        ts_ip = peer["ts_ip"]
        online = peer["online"]
        user, lan_ip = DEVICE_MAP.get(host, ("", ""))

        ts_ms = ts_ping(ts_ip) if ts_ip else "FAIL"
        ts_ssh_ok, ts_ssh_ms = ("-", "-")
        if ts_ip and user:
            ts_ssh_ok, ts_ssh_ms = ts_ssh(user, ts_ip)

        lan_ms = icmp_ping(lan_ip) if lan_ip else "-"
        rows.append({
            "device": host,
            "display": peer["display"],
            "ts_ip": ts_ip,
            "online": online,
            "ts_ping_ms": ts_ms,
            "ts_ssh_user": user,
            "ts_ssh_ok": ts_ssh_ok,
            "ts_ssh_ms": ts_ssh_ms,
            "lan_ip": lan_ip,
            "lan_ping_ms": lan_ms,
        })

    public_rows = public_checks()

    print("=== 设备连通性 (Tailscale + LAN) ===")
    header = "device|display|ts_ip|online|ts_ping_ms|ts_ssh_user|ts_ssh_ok|ts_ssh_ms|lan_ip|lan_ping_ms"
    print(header)
    for r in rows:
        print(
            f"{r['device']}|{r['display']}|{r['ts_ip']}|{r['online']}|{r['ts_ping_ms']}|"
            f"{r['ts_ssh_user']}|{r['ts_ssh_ok']}|{r['ts_ssh_ms']}|{r['lan_ip']}|{r['lan_ping_ms']}"
        )

    print("\n=== 公网入口抽检 ===")
    print("device|target|kind|status|latency_ms")
    for r in public_rows:
        print(f"{r['device']}|{r['target']}|{r['kind']}|{r['status']}|{r['latency_ms']}")

    # 汇总
    n_peers = len([r for r in rows if r["device"] != "self"])
    online_ok = sum(1 for r in rows if r["online"] and r["device"] != "self")
    ts_ping_ok = sum(1 for r in rows if r["ts_ping_ms"] != "FAIL" and r["device"] != "self")
    ts_ssh_ok_count = sum(1 for r in rows if r["ts_ssh_ok"] == "OK" and r["device"] != "self")
    lan_ping_ok = sum(1 for r in rows if r["lan_ping_ms"] != "FAIL" and r["lan_ping_ms"] != "-" and r["device"] != "self")
    lan_ping_total = sum(1 for r in rows if r["lan_ping_ms"] != "-" and r["device"] != "self")
    public_ok = sum(1 for r in public_rows if r["status"] not in ("FAIL", "-"))

    print("\n=== 汇总 ===")
    print(f"Tailscale 在线率: {online_ok}/{n_peers} ({online_ok / n_peers * 100:.1f}%)")
    print(f"Tailscale Ping 成功率: {ts_ping_ok}/{n_peers} ({ts_ping_ok / n_peers * 100:.1f}%)")
    print(f"Tailscale SSH 成功率: {ts_ssh_ok_count}/{n_peers} ({ts_ssh_ok_count / n_peers * 100:.1f}%)")
    if lan_ping_total:
        print(f"LAN Ping 成功率: {lan_ping_ok}/{lan_ping_total} ({lan_ping_ok / lan_ping_total * 100:.1f}%)")
    print(f"公网抽检成功率: {public_ok}/{len(public_rows)} ({public_ok / len(public_rows) * 100:.1f}%)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
