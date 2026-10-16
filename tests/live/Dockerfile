# The SSH target of the live gates: a throwaway OpenSSH host, built for one
# run and removed with it (tests/browser/live_world.mjs). Nothing here is a
# secret; the account's password is generated per run and set at start.
#
# tmux and python3 because the gates drive tmux sessions and run the omp
# stand-ins in tests/fixtures; procps because live_e2e_v5 cuts the transport
# with pkill.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server tmux python3 procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && useradd --create-home --shell /bin/bash deck

COPY target-entrypoint.sh /usr/local/sbin/target-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/target-entrypoint"]
