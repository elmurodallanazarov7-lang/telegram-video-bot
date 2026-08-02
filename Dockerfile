FROM node:20-slim

# Python, ffmpeg, aria2 va yt-dlp uchun kerakli paketlar
# aria2 -- parallel (bir nechta ulanishli) yuklash uchun, sezilarli tezlik beradi
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    unzip \
    aria2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp'ni to'g'ridan-to'g'ri binary sifatida o'rnatish (eng so'nggi versiya)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Deno -- yt-dlp'ga YouTube'ning JS-asosidagi signature/challenge'larini yechishga yordam beradi
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "index.js"]
