# Caddy with the Cloudflare DNS plugin, so Let's Encrypt can check you own your domain through DNS
# (the home address is only on the home network, so the usual web check can't reach it).
# The binary comes from Caddy's official build service, which is lighter than compiling it here.
FROM caddy:2
ARG TARGETARCH=amd64
ADD --chmod=755 "https://caddyserver.com/api/download?os=linux&arch=${TARGETARCH}&p=github.com%2Fcaddy-dns%2Fcloudflare" /usr/bin/caddy
RUN caddy list-modules | grep -q dns.providers.cloudflare
