# deploy/infra/spark drafts (box mirror)

Mirror intended repo path: `deploy/infra/spark/`.

| File | Purpose |
|------|---------|
| `dsv41-rank1.service` | spark01 systemd unit (draft) |
| `dsv41-rank0.service` | spark02 :8888 unit (draft) |
| `dsv41-rank1-docker.sh` | ExecStart wrapper from live inspect |
| `dsv41-rank0-docker.sh` | ExecStart wrapper from live inspect |
| `dsv41-tensorfold-head.service.example` | upstream `./start.sh` supervisor alternative |
| `RUNBOOK.md` | order, health, cold-start, do-nots |
| `ENV_PORT_SUGGESTION.md` | .env :8888 vs leftover :8000 notes |

**Not installed. Not enabled. Prod untouched.**
