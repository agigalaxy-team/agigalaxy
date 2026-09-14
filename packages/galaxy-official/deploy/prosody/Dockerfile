FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl make gcc libc6-dev lua5.4 liblua5.4-dev libicu-dev libssl-dev \
    lua-socket lua-sec lua-expat lua-filesystem && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/prosody
RUN curl --fail --show-error --location https://prosody.im/downloads/source/prosody-13.0.6.tar.gz -o /tmp/prosody.tar.gz \
    && echo 'ec696f9cf562c3af4a04b07d3fb36a1cedcc4e69a392fddcfc524bc67d93050f  /tmp/prosody.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/prosody.tar.gz --strip-components=1 -C /opt/prosody \
    && ./configure --prefix=/usr/local --lua-version=5.4 --idn-library=icu \
    && make -j2 && make install && rm /tmp/prosody.tar.gz
CMD ["/usr/local/bin/prosody", "--config", "/etc/prosody/prosody.cfg.lua", "--no-daemonize"]
