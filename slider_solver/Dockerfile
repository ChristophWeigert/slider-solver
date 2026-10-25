# A plain Node base plus only Chromium, instead of the full Playwright image: that one
# also carries Firefox and WebKit, which the solver never launches. It exists for
# amd64 and arm64, matching the arch list in config.yaml.
#
# Chromium is installed by the pinned playwright-core, so the browser and the
# client library are the same version by construction: bump package.json only.
FROM node:20-bookworm-slim

WORKDIR /app

# The base image keeps no browsers, so say where they go. solver.mjs looks for a
# full `chromium-*` build under this path.
ENV HEADLESS=true \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBUG_DIR=/data/debug

COPY package.json ./

# The headless shell build is deleted: solver.mjs names the full browser explicitly
# and never uses it.
RUN npm install --omit=dev --no-audit --no-fund \
 && apt-get update \
 && npx playwright-core install --with-deps chromium \
 && rm -rf /ms-playwright/chromium_headless_shell-* /root/.npm /var/lib/apt/lists/*

COPY solver.mjs server.mjs run.sh ./
RUN chmod +x /app/run.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/run.sh"]
