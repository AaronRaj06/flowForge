FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci -w web --include-workspace-root=false
COPY web web
WORKDIR /app/web
CMD ["npx", "vite", "--host", "0.0.0.0"]
