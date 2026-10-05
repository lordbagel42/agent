FROM node:24.21.0-bookworm-slim

# Build once; VM boots never install packages or fetch browser binaries.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates chromium curl fonts-liberation git jq python3 \
    python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --allow-scripts=agent-browser agent-browser@0.38.2 \
    && npm cache clean --force \
    && usermod --login user --home /home/user --move-home node \
    && groupmod --new-name user node \
    && mkdir /workspace && chown user:user /workspace

ENV HOME=/home/user \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
COPY smoke.sh /usr/local/bin/june-environment-smoke
RUN chmod 755 /usr/local/bin/june-environment-smoke
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
