FROM node:22-slim
# python3/make/g++ build isolated-vm's native addon when no prebuilt binary matches.
RUN apt-get update && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
# isolated-vm needs this on Node 20+.
ENV NODE_OPTIONS=--no-node-snapshot
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --include-workspace-root=false
COPY server server
WORKDIR /app/server
RUN npx prisma generate
CMD ["npx", "tsx", "src/api/index.ts"]
