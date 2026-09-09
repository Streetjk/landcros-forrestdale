# SiteNav — Node web service (server.js). Used by Koyeb (Docker deploy) and by
# deploy/oracle-setup.sh on an Oracle Always Free VM. Render keeps using
# render.yaml (native Node runtime) — both paths run the same `node server.js`.
FROM node:22-alpine

WORKDIR /app

# Install prod deps first so this layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
# The host injects PORT (Koyeb: 8000 by default). server.js falls back to
# 50000 locally; keep both in sync with EXPOSE for platforms that read it.
ENV PORT=8000
EXPOSE 8000

# Runtime config comes from the platform's env/secrets UI, never the image:
#   SITE, SESSION_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_DB_URL,
#   PLATFORM_ADMIN_EMAILS, RESEND_API_KEY, MAIL_FROM, PUBLIC_BASE_URL
USER node
CMD ["node", "server.js"]
