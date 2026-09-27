FROM python:3.12-slim

# arp-scan finds the devices on the home network; Ookla's official CLI runs the speed test.
ARG SPEEDTEST_VERSION=1.2.0
RUN apt-get update && apt-get install -y --no-install-recommends arp-scan curl ca-certificates \
    && case "$(uname -m)" in x86_64) A=x86_64 ;; aarch64) A=aarch64 ;; armv7l) A=armhf ;; *) A=x86_64 ;; esac \
    && curl -fsSL "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${A}.tgz" \
       | tar -xz -C /usr/local/bin speedtest \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1
COPY netmon.py /netmon.py
CMD ["python", "/netmon.py"]
