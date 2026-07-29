# ToIV 真机部署说明

> 2026-07-28 更新:Workstation Docker 已全清,ToIV 必须真机部署。本目录提供 systemd 服务文件与安装脚本。
> 远端 core 当前目录结构为 `/home/merlin/toiv/{api,web,deploy}`(旧结构),服务文件已按此路径编写。

## 适用场景

- Workstation/core 等 Ubuntu 真机
- 目标机器已禁用 Docker 或不愿承担 Docker 开销
- 需要 toiv-api :8090 + toiv-web :3100 长期在线

## 前置要求

- Ubuntu 22.04+/26.04
- Python 3.11+、Node.js 22+、npm
- git 或 rsync 已将源码同步到 `/home/merlin/toiv/{api,web,deploy}`
- 已配置 `deploy/.env`(至少 JWT_SECRET、ADMIN_PASSWORD)
- 目标机器能访问 workstation 的 :8000/:9200/:9302、pc01/pc02 的 ComfyUI、NAS 等

## 文件说明

| 文件 | 用途 |
|------|------|
| `toiv-api.service` | systemd 服务:uvicorn app.main:app --port 8090 |
| `toiv-web.service` | systemd 服务:npm run start --port 3100 |
| `install.sh` | 一键安装:创建 venv、npm build、安装并启动 systemd 服务 |

## 部署步骤

1. 同步源码到目标机(如 core 192.168.71.47):
   ```bash
   rsync -az --delete --exclude=.venv --exclude=node_modules --exclude=.next --exclude=.git \
     api web deploy merlin@192.168.71.47:/home/merlin/toiv/
   ```

2. 在目标机上配置环境变量:
   ```bash
   sudo -u merlin cp /home/merlin/toiv/deploy/.env.example /home/merlin/toiv/deploy/.env
   sudo -u merlin nano /home/merlin/toiv/deploy/.env
   # 必填:TOIV_JWT_SECRET、TOIV_ADMIN_PASSWORD、TOIV_CORS_ORIGINS
   ```

3. 运行安装脚本:
   ```bash
   ssh merlin@192.168.71.47
   sudo bash /home/merlin/toiv/deploy/bare-metal/install.sh
   ```

4. 验证:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" localhost:8090/openapi.json
   curl -s -o /dev/null -w "%{http_code}\n" localhost:3100
   ```

## 回滚

```bash
sudo systemctl stop toiv-api toiv-web
sudo systemctl disable toiv-api toiv-web
```

## 与 Docker 部署的关系

- `deploy/docker-compose.yml` 保留,供仍有 Docker 的机器使用
- 真机部署与 Docker 部署互不依赖,任选其一
