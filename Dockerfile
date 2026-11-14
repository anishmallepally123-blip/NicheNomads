# One container that serves both the website and the API on $PORT (default 8000).
# Works on any host that runs Docker: Render, Fly.io, Railway, Google Cloud Run,
# Azure Container Apps, AWS App Runner, a plain VM...

# ---- 1. Build the frontend ----
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Optional build-time settings (see .env.example). Leave empty for defaults.
ARG VITE_API_BASE=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENVIRONMENT="production"
ARG VITE_APP_VERSION="dev"
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT \
    VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

# ---- 2. Python backend + built site ----
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    SPHEREX_CACHE_DIR=/data/cache
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist /app/frontend/dist

RUN useradd --create-home --uid 10001 spherex \
    && mkdir -p /data/cache && chown -R spherex /data
USER spherex
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health', timeout=4)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
