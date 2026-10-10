# The official Playwright image carries Chromium and every shared library it needs,
# which is the whole difficulty of containerising this. It exists for amd64 and
# arm64, matching the arch list in config.yaml.
#
# Bump this tag and package.json's playwright-core together: the browser in the
# image and the client library must be the same version.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY solver.mjs server.mjs run.sh ./
RUN chmod +x /app/run.sh

ENV HEADLESS=true \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBUG_DIR=/data/debug

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/run.sh"]
