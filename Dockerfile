# ---- build stage -------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Full install (dev deps needed for the Remix/Vite build)
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# SHOPIFY_API_KEY is not needed at build time: app.jsx serves it from the
# loader at request time, so the runtime env var is enough.
RUN npm run build

# ---- runtime stage -----------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# Cloud Run injects PORT; remix-serve honours it.
ENV PORT=8080
EXPOSE 8080

# No prisma migrate: sessions live in MemorySessionStorage and shop tokens in
# Supabase, so there is no local database to migrate. Running it here would
# fail on Cloud Run's read-only filesystem.
CMD ["npm", "run", "start"]
