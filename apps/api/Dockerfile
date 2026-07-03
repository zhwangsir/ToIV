FROM python:3.12-slim

WORKDIR /app

# 系统依赖(换清华 Debian 镜像加速 apt):
#   ffmpeg          漫剧自动剪辑拼接
#   fonts-noto-cjk  烧录字幕 / 片头尾卡的中文字形
#   libredwg        CAD 工作台 DWG→DXF(GNU 0.13.3 tarball 编译,免 autogen;dwg2dxf 命令)
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk build-essential pkg-config ca-certificates \
    && python3 -c "import urllib.request, tarfile; urllib.request.urlretrieve('https://mirrors.tuna.tsinghua.edu.cn/gnu/libredwg/libredwg-0.13.3.tar.xz', '/tmp/l.tar.xz'); tarfile.open('/tmp/l.tar.xz').extractall('/tmp')" \
    && cd /tmp/libredwg-0.13.3 \
    && ./configure --disable-bindings --disable-dependency-tracking \
    && make -j4 && make install && ldconfig \
    && cd / && rm -rf /tmp/libredwg-0.13.3 /tmp/l.tar.xz /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --timeout 120 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r requirements.txt
# CAD 设计:ezdxf 读 DXF 抽几何,matplotlib 渲线稿/轴测(DWG 需 dwg2dxf,见下方 COPY)
RUN pip install --no-cache-dir --timeout 120 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    ezdxf==1.4.2 matplotlib==3.9.4

# 译制听写:faster-whisper(CPU/CTranslate2)。模型走 HF 镜像,缓存到 /data 持久卷(免每次重下)
# requests 是 faster-whisper utils.py 的隐式依赖(1.1.1 未声明,缺则 import 即 ModuleNotFoundError)
RUN pip install --no-cache-dir --timeout 180 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    faster-whisper==1.1.1 requests
# 动漫对口型(本地自建):opencv 做动漫脸检测(lbpcascade_animeface)+ 逐帧嘴区形变。
# headless 版免 GUI 依赖;numpy 随之装。CV 是经典算法非模型推理,CPU 短片可接受。
RUN pip install --no-cache-dir --timeout 180 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    opencv-python-headless==4.10.0.84
# NAS 模型下载:paramiko 走 SFTP 把模型上传到 NAS 的 ComfyUI models 目录
RUN pip install --no-cache-dir --timeout 180 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    paramiko==3.5.0

COPY app ./app

ENV TOIV_DATABASE_URL=sqlite:////data/toiv.db
# Whisper 模型缓存到持久卷 + HF 国内镜像(首次听写自动下载)
ENV HF_HOME=/data/whisper
ENV HF_ENDPOINT=https://hf-mirror.com
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
