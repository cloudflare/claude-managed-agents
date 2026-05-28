# Cloudflare Sandbox base image — provides the sandbox runtime that the
# Worker SDK (`@cloudflare/sandbox`) talks to over port 3000 (exec, terminals,
# file I/O, etc.). Do NOT override ENTRYPOINT or the runtime won't start.
FROM docker.io/cloudflare/sandbox:0.10.1

ENV PATH="/usr/local/bin:/usr/bin:/bin:/home/claude/.npm-global/bin:/home/user/.npm-global/bin:${PATH}"

# ---------------------------------------------------------------------------
# System utilities & build essentials (kept minimal — sandbox base ships most)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    bc \
    ca-certificates \
    curl \
    file \
    git \
    jq \
    less \
    lsof \
    nano \
    netcat-openbsd \
    ripgrep \
    sudo \
    tmux \
    unzip \
    vim \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Anthropic agent runner CLI (`ant`). We keep it on PATH and start it via
# `sandbox.startProcess(...)` from the worker after dispatch — running it as
# the entrypoint would replace the sandbox runtime. This build also resolves
# the session's agent skills and mounts them under `/workspace/skills/<name>/`
# before any tool runs (see the 0512 self-hosted integration guide).
# ---------------------------------------------------------------------------
ARG ANT_VERSION=1.9.1
# TARGETARCH is a BuildKit-provided global ARG (amd64 / arm64), but it has to
# be redeclared inside the stage before it expands in `RUN`.
ARG TARGETARCH
RUN curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin ant \
 && chmod +x /usr/local/bin/ant

# ---------------------------------------------------------------------------
# Trust the Cloudflare egress proxy CA for Go-based binaries.
#
# The sandbox runtime (interceptHttps = true) injects an ephemeral CA at
# /etc/cloudflare/certs/cloudflare-containers-ca.crt and auto-trusts it
# for curl, Node.js, Python, and Git on startup — but Go's net/http uses
# its own cert loading from /etc/ssl/certs/ca-certificates.crt and does
# not pick up the injected CA automatically. Any Go CLI (gh, terraform,
# kubectl, etc.) will fail with "x509: certificate signed by unknown
# authority" when the egress proxy intercepts HTTPS.
#
# This profile.d script appends the Cloudflare CA to the system bundle
# on first shell init so Go binaries can verify TLS through the proxy.
# ---------------------------------------------------------------------------
RUN printf '#!/bin/sh\nif [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && ! grep -q "Cloudflare" /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then\n  cat /etc/cloudflare/certs/cloudflare-containers-ca.crt >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true\nfi\n' > /etc/profile.d/cf-ca-trust.sh \
 && chmod 0644 /etc/profile.d/cf-ca-trust.sh

WORKDIR /workspace
RUN mkdir -p /workspace

# The dashboard PTY terminal goes through @cloudflare/sandbox's `terminal()`
# RPC, whose `PtyOptions` type doesn't expose a `cwd` (only cols/rows/shell).
# Without that, the shell spawned by the in-container runtime lands in its
# own default cwd (typically $HOME = /root) instead of /workspace — so files
# the agent writes to /workspace look "missing" from the terminal. Force
# both interactive and login shells to land in /workspace so the terminal
# view matches what the agent sees.
RUN printf '\n# Land in the agent workspace by default.\ncd /workspace 2>/dev/null || true\n' >> /root/.bashrc \
 && printf '# Land in the agent workspace by default.\ncd /workspace 2>/dev/null || true\n' > /etc/profile.d/cd-workspace.sh \
 && chmod 0644 /etc/profile.d/cd-workspace.sh

# 3000 is the sandbox runtime; 8080 is for user code if it exposes a server.
EXPOSE 3000
EXPOSE 8080
