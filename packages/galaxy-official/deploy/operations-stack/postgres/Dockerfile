ARG POSTGRES_BASE_IMAGE
FROM ${POSTGRES_BASE_IMAGE} AS build
USER root
ARG PGBACKREST_VERSION=2.60.0
RUN test -f /etc/debian_version && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl meson ninja-build gcc pkg-config libpq-dev libssl-dev libxml2-dev \
    liblz4-dev libzstd-dev libbz2-dev zlib1g-dev libssh2-1-dev libsystemd-dev \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /build && curl --fail --silent --show-error --location \
    "https://github.com/pgbackrest/pgbackrest/releases/download/release%2F${PGBACKREST_VERSION}/pgbackrest-${PGBACKREST_VERSION}.tar.gz" \
    -o /build/source.tar.gz \
    && tar -xzf /build/source.tar.gz -C /build \
    && meson setup /build/output "/build/pgbackrest-${PGBACKREST_VERSION}" \
    && ninja -j2 -C /build/output

FROM ${POSTGRES_BASE_IMAGE}
USER root
RUN test -f /etc/debian_version && apt-get update && apt-get install -y --no-install-recommends \
    libxml2 libssh2-1 liblz4-1 libzstd1 libpq5 libsystemd0 libbz2-1.0 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/output/src/pgbackrest /usr/local/bin/pgbackrest
COPY galaxy-pgbackrest /usr/local/bin/galaxy-pgbackrest
RUN chmod 0755 /usr/local/bin/pgbackrest /usr/local/bin/galaxy-pgbackrest
RUN mkdir -p /etc/pgbackrest /var/lib/pgbackrest /var/log/pgbackrest /var/run/pgbackrest /var/spool/pgbackrest /run/secrets
# The original PostgreSQL entrypoint, user transition and data-volume layout remain inherited.
