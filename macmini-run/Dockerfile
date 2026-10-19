# Runs ../social-media-mcp-macmini unmodified. Build context is that project (read-only);
# this file and its compose file live outside it on purpose.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.6.4 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

COPY requirements-google.txt ./
RUN uv venv .venv-google --python 3.12 \
  && uv pip install --python .venv-google/bin/python -r requirements-google.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# src/server.js calls process.loadEnvFile('.env') and fails if it is missing. Keep it empty;
# real values come from the container environment (loadEnvFile never overrides those).
RUN touch .env && mkdir -p .credentials logs \
  && chown -R node:node /app/.env /app/.credentials /app/logs

USER node
ENV MCP_HOST=0.0.0.0 MCP_PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
