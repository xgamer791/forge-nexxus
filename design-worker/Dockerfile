FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
# server.mjs imports the measured capture, the layout check and the spec.
COPY server.mjs capture.mjs layout.mjs reference.mjs spec.mjs cli.mjs NOTICE ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
