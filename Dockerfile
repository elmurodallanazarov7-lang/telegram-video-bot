FROM node:20-bookworm-slim
 
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 ffmpeg curl ca-certificates \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*
 
WORKDIR /app
 
COPY package.json ./
RUN npm install --omit=dev
 
COPY index.js ./
RUN mkdir -p /app/downloads
 
ENV NODE_ENV=production
EXPOSE 10000
 
CMD ["node", "index.js"]
