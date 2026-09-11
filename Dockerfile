FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
RUN mkdir -p /var/lib/sbx && chown bun:bun /var/lib/sbx
USER bun
EXPOSE 3410
VOLUME ["/var/lib/sbx"]
ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["run", "--dir", "/var/lib/sbx"]
