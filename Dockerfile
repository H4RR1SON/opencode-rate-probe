FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY . .
EXPOSE 10000
CMD ["bun", "run", "server.ts"]
