# FR-23. Node 24 for node:sqlite (built into the Node binary, no native
# addon build step needed) — matches the version used in development and CI.
FROM node:24-slim

WORKDIR /app

# Install deps first so this layer only rebuilds when package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Cloud Run injects its own PORT at deploy time regardless of this default —
# see health.js's healthPort(). Documentation only; doesn't control binding.
EXPOSE 8080

# Run node directly (not `npm start`) so SIGTERM reaches the process
# directly for Cloud Run's graceful-shutdown request draining, instead of
# being absorbed by an intermediate npm wrapper process.
CMD ["node", "app.js"]
