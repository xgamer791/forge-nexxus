FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# SkillUI ultra is the design extract. Playwright's Chromium serves both
# page discovery and `skillui --mode ultra`.
RUN npm install -g skillui@1.3.4 && npm ci --omit=dev && npx playwright install --with-deps chromium
COPY server.mjs discover.mjs extract.mjs auditors.mjs urls.mjs ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
