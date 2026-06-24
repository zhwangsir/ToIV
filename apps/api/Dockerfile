FROM python:3.12-slim

WORKDIR /app

# ffmpeg:漫剧自动剪辑(/api/manju/assemble)拼接片段需要
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --timeout 120 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r requirements.txt

COPY app ./app

ENV TOIV_DATABASE_URL=sqlite:////data/toiv.db
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
