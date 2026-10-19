FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.6.4 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

# Google Ads MCP server (pinned in requirements-google.txt) in its own venv.
COPY requirements-google.txt ./
RUN uv venv .venv-google --python 3.12 \
  && uv pip install --python .venv-google/bin/python -r requirements-google.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p .credentials /data && chown -R node:node /app/.credentials /data

USER node
ENV HOST=0.0.0.0 PORT=8780 NODE_ENV=production
EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8780/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
