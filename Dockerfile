# 그때 뭐랬지? MCP 서버 — 카카오클라우드 등 컨테이너 환경 배포용
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/memories.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 비루트로 실행되는 환경(K8s 등)에서도 DB 디렉토리에 쓸 수 있게 한다
RUN mkdir -p /data && chmod 777 /data
EXPOSE 3000
CMD ["node", "dist/server.js"]
