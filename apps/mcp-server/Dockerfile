FROM oven/bun:1.4.2-alpine

# What the tools start: python3 for the Redmine ticket helper; for a mounted project folder
# its recipes run with just, bash, jq and curl, and ask Docker through docker-cli.
# just comes from its release page at a fixed version, checked against its published checksum.
ARG JUST_VERSION=1.40.0
ARG JUST_SHA256_X86_64=181b91d0ceebe8a57723fb648ed2ce1a44d849438ce2e658339df4f8db5f1263
ARG JUST_SHA256_AARCH64=d065d0df1a1f99529869fba8a5b3e0a25c1795b9007099b00dfabe29c7c1f7b6
RUN apk add --no-cache docker-cli curl bash python3 py3-pip py3-yaml py3-psutil jq \
    && arch="$(apk --print-arch)" \
    && case "$arch" in \
         x86_64) sum="$JUST_SHA256_X86_64" ;; \
         aarch64) sum="$JUST_SHA256_AARCH64" ;; \
         *) echo "no just build for $arch" >&2; exit 1 ;; \
       esac \
    && curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/just.tar.gz \
         "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
    && echo "${sum}  /tmp/just.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/just.tar.gz -C /usr/local/bin just \
    && rm /tmp/just.tar.gz

WORKDIR /app

# Dependencies first (lockfile included for reproducible installs)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tools ./tools
# The client scripts people download from the server (/client.sh, /client.ps1).
COPY mcp-client.sh mcp-client.ps1 ./

# data: sign-in store and the ticket helper's log. project: an installation's project folder, when it mounts one.
RUN mkdir -p /app/data /app/project

EXPOSE 9125

CMD ["bun", "run", "src/server.ts"]
