FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src TIKTOKEN_CACHE_DIR=/app/tokenizers
WORKDIR /app
COPY services/galaxy-operations-agentos/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
RUN mkdir -p "$TIKTOKEN_CACHE_DIR" && python -c "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')" && chmod -R a+rX "$TIKTOKEN_CACHE_DIR"
COPY services/galaxy-operations-agentos/src ./src
COPY services/galaxy-operations-agentos/tests ./tests
COPY services/galaxy-operations-agentos/model-bindings.empty.json ./model-bindings.empty.json
ARG GALAXY_AGENTOS_CHECK=bindings
RUN case "$GALAXY_AGENTOS_CHECK" in \
      bindings) python -m unittest discover -s tests -p 'test_model_gateway.py' -v ;; \
      metadata-http) python -m unittest discover -s tests -p 'test_model_settings_http.py' -v ;; \
      model-settings) python -m unittest discover -s tests -p 'test_model_profiles.py' -v ;; \
      *) exit 1 ;; esac
RUN groupadd --gid 10001 agentos && useradd --uid 10001 --gid agentos --no-create-home agentos
USER 10001:10001
EXPOSE 7791
CMD ["python", "-m", "galaxy_agentos.app"]
