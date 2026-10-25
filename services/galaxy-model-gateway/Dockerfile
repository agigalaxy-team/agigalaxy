FROM rust:1.98.0-slim-bookworm AS rust-toolchain

FROM python:3.12-slim-bookworm AS native-builder
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev libffi-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.13.5
WORKDIR /opt/litellm
# The dedicated build tool downloads this exact commit. No latest branch or
# different PyPI package is substituted for the reviewed source/lock.
COPY upstream ./
RUN uv sync --frozen --extra proxy --no-dev --no-editable --no-install-package litellm-enterprise

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src \
    PATH=/opt/litellm/.venv/bin:$PATH \
    LITELLM_LOCAL_MODEL_COST_MAP=True LITELLM_TELEMETRY_DISABLED=true DO_NOT_TRACK=1
WORKDIR /app
COPY --from=native-builder /opt/litellm/.venv /opt/litellm/.venv
COPY upstream/LICENSE /app/licenses/litellm-LICENSE
COPY upstream/litellm-proxy-extras/LICENSE /app/licenses/litellm-proxy-extras-LICENSE
COPY upstream/uv.lock /app/provenance/upstream-uv.lock
COPY upstream/pyproject.toml /app/provenance/upstream-pyproject.toml
COPY services/galaxy-model-gateway/SOURCE.json /app/provenance/SOURCE.json
COPY services/galaxy-model-gateway/src ./src
COPY services/galaxy-model-gateway/config ./config
COPY services/galaxy-model-gateway/tests ./tests
ARG GALAXY_GATEWAY_CHECK=all
RUN python -c "import importlib.util; assert importlib.util.find_spec('litellm_enterprise') is None" \
    && case "$GALAXY_GATEWAY_CHECK" in \
       all) python -m unittest discover -s tests -p 'test_gateway.py' -v ;; \
       native) PYTHONPATH=/app/src:/app/tests python -m unittest test_gateway.GatewayTest.test_01_native_empty_proxy_starts_without_enterprise_and_rejects_before_prompt -v ;; \
       protocol) PYTHONPATH=/app/src:/app/tests python -m unittest test_gateway.GatewayTest.test_02_configured_admission_uses_native_protocol_and_metadata_only_without_model_call -v ;; \
       model-settings) PYTHONPATH=/app/src:/app/tests python -m unittest test_model_profiles -v ;; \
       model-settings-native) PYTHONPATH=/app/src:/app/tests python -m unittest test_model_profiles.ModelProfilesTest.test_01_native_proxy_four_protocols_and_durable_usage_with_local_provider_double -v ;; \
       *) exit 1 ;; esac
RUN groupadd --gid 10002 modelgateway && useradd --uid 10002 --gid modelgateway --no-create-home modelgateway
USER 10002:10002
EXPOSE 3351
CMD ["python", "-m", "galaxy_model_gateway.app"]
