FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/mealplanner.db PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
