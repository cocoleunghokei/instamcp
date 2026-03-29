FROM node:20-bullseye-slim

# Install Chromium + dependencies (works on both amd64 and arm64)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends && \
    # Normalize browser path — some distros use chromium-browser, others chromium
    (test -f /usr/bin/chromium || ln -s /usr/bin/chromium-browser /usr/bin/chromium) && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium instead of downloading its own
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/server

# Install dependencies (node_modules lives next to index.js)
COPY server/package.json ./
RUN npm install --omit=dev

# Copy source
COPY server/ ./
WORKDIR /app
COPY web/ ./web/

WORKDIR /app/server

EXPOSE 3000

CMD ["node", "index.js"]
