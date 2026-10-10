FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /opt/june-apps
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY src ./src
RUN corepack pnpm install --frozen-lockfile --ignore-scripts --prod=false --package-import-method=copy \
    && node -e 'const {createRequire}=require("node:module"); const r=createRequire(require.resolve("rivetkit")); if(r("@rivetkit/engine-cli/package.json").version!=="2.3.21") throw Error("engine_version"); require("node:fs").copyFileSync(r("@rivetkit/engine-cli").getEnginePath(),"/opt/june-apps/rivet-engine");' \
    && chmod 755 /opt/june-apps/rivet-engine \
    && mkdir /data && chown 10001:10001 /data \
    && rm -rf /root/.local/share/pnpm/store /root/.cache
ENV NODE_ENV=production HOME=/data
USER 10001:10001
CMD ["node", "src/apps/supervisor.mjs"]
