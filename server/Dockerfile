FROM node:22-slim
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --include-workspace-root=false
COPY server server
WORKDIR /app/server
RUN npx prisma generate
CMD ["npx", "tsx", "src/api/index.ts"]
