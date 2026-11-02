# ToIV spark TensorFold DSv4.1 — systemd runbook (DRAFT)

**Date:** 2026-11-02 Asia/Shanghai  
**Status:** drafts only under `/workspace/ops-drafts/deploy-infra-spark/` — **not** installed, **not** enabled  
**Live target:** `dsv41-1017-exl3-tf` / image `tensorfold-dsv41:exl3-tp2-928adbd0e57d`  
**Not target:** `dsv4_60`, `dsv4-serve.sh`, Qwen38, `:8000`

## Topology

| Rank | Host | LAN | RAIL | Role | API |
|------|------|-----|------|------|-----|
| 1 | spark01 | 192.168.71.82 | 192.168.200.13 | `tf-dsv41-lanes` worker | headless |
| 0 | spark02 | 192.168.71.84 | 192.168.200.12 | `tensorfold-native serve` | **`:8888`** |

- Checkout with `./start.sh` (preferred orchestrator): **spark02 only**  
  `~/DeepSeek-v4.1-Flash-1017-2x-DGX-Sparks` (absent on spark01)  
- Live `RestartPolicy=no` on both containers → reboot currently drops LLM.

## Start order (hard)

1. **spark01 rank1 first** — start `dsv41-rank1.service` (or ensure worker container running).  
2. **Wait ready** — rank1 process alive / RAIL up (no public HTTP on worker). Practical gate: `docker ps` shows `dsv41-1017-exl3-tf` Up on spark01; optionally watch logs until lanes bind to master `192.168.200.12:29620`.  
3. **spark02 rank0** — start `dsv41-rank0.service`.  
4. **Health** — `curl -fsS http://192.168.71.84:8888/health` and/or `/v1/models` → model `DeepSeek-V4.1-Flash-1017`.  
5. Optional completion smoke via `/v1/chat/completions`.

**Cold start:** weight fault-in / load **10–45 min** is normal. Units use `TimeoutStartSec=0`.

### Alternative (single head unit)

On spark02 only, use upstream-style `dsv41-tensorfold-head.service.example` → `./start.sh` (FOREGROUND=1 PREPARE=0). That script already does rank1-via-SSH then rank0. Still requires passwordless SSH spark02→spark01 on RAIL/LAN.

## Stop order

Prefer reverse: stop rank0 (API) first, then rank1. Or use `./stop.sh` on spark02 if using head launcher.

## Do NOT

- Short `TimeoutStartSec` (kills mid-load).  
- Start rank0 before rank1 (NCCL/RAIL / pair-broken).  
- Point text LLM clients at `:8000` (stock `dsv4_60` path; not live).  
- Touch spark02 **DRT LiveKit** containers (`drt-livekit*`, `drt-meeting-redis`).  
- Delete exited rollback containers (`qwen38sg`, `vllm_node-v2`, etc.).  
- `docker update --restart=unless-stopped` as a substitute for ordered systemd (still lacks rank order + long timeout).  
- Run `PREPARE=1` under systemd (rebuild/download); prepare interactively first.  
- Enable lingering / install units in this draft wave.

## Install sketch (future change window only)

```bash
# On each host, after copying scripts + units and fixing absolute ExecStart paths:
# spark01:
install -m 0755 dsv41-rank1-docker.sh /home/dgmt-spark/bin/
# sudo cp dsv41-rank1.service /etc/systemd/system/   # or user unit
# sudo systemctl daemon-reload
# Manual ordered start test — do NOT enable until reboot drill passes.
```

## Evidence (recon 2026-11-02)

- Launcher provenance: Mia checkout `start.sh` on spark02; live containers match inspect Cmd/Binds.  
- No on-disk one-shot “dsv41-docker.sh” besides recipe `start.sh` / this draft reconstruction.  
- core `deploy/.env`: `TOIV_LLM*_BASE_URL` already `http://192.168.71.84:8888/v1`.
