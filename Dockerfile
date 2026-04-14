FROM node:18-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Create the persistent-volume mount point.
# Railway will mount a volume at /data — uploads survive redeploys.
RUN mkdir -p /data/downloads /data/jingles /data/playlists /data/schedule

EXPOSE 3000
CMD ["node", "server.js"]
