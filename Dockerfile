FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PHOTO_SORTER_ROOT=/storage/photo-sorter \
    PHOTO_SORTER_DATA=/data \
    PHOTO_SORTER_CACHE=/cache

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /storage/photo-sorter /data /cache \
    && chown -R node:node /app /storage /data /cache

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
