FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    "fastapi>=0.115" "uvicorn[standard]>=0.32" "httpx>=0.27" \
    "websockets>=13" "sse-starlette>=2.1" "pydantic-settings>=2.5" \
    "sqlmodel>=0.0.22" "pyjwt>=2.9" "python-multipart>=0.0.12"

COPY app ./app

ENV TOIV_DATABASE_URL=sqlite:////data/toiv.db
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
