FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src
WORKDIR /app
COPY services/galaxy-operations-agentos/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
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
