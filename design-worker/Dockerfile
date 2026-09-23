FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# SkillUI Ultra drives the same Playwright Chromium the page discovery agent uses.
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY server.mjs discover.mjs skillui.mjs ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
