FROM python:3.11-slim

WORKDIR /app

# Build deps kept in a single layer; the toolchain stays in this image but the
# runtime now runs as a non-root user (audit H-4 fix).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/store/models && \
    chown -R nobody:nogroup /app/store

# FIX (audit H-4): container previously ran as root. Drop to an unprivileged
# user and add a HEALTHCHECK for the FastAPI service.
USER nobody

EXPOSE 8100

# v21.11.0 PORT-COLLISION FIX: 8000 → 8100 (8000 = LAYA's home port —
# the Node meta-ensemble client was probing Laya instead of this service).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8100/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
