FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
# server.mjs imports capture, reference, layout and spec. Copy every module
# the process loads, or the container exits before it listens.
COPY *.mjs ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
