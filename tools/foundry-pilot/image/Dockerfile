# BASE_IMAGE must be an owner-vetted, preloaded Node image pinned by sha256.
# No default, downloads, package manager, mounts or runtime credentials.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /opt/foundry
COPY --chown=65532:65532 event-summary.cjs /opt/foundry/event-summary.cjs
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/foundry/event-summary.cjs"]
