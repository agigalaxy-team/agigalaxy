import re

from agno.tracing.exporter import DatabaseSpanExporter
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status
from openinference.instrumentation.agno import AgnoInstrumentor


class MetadataOnlyExporter(DatabaseSpanExporter):
    """Keep native trace relationships/timing, omit content and exception prose."""

    def export(self, spans):
        safe = []
        id_keys = {"run_id", "session_id", "user_id", "agent_id", "team_id", "workflow_id",
            "agno.run.id", "agno.session.id", "agno.user.id", "agno.agent.id", "agno.team.id", "agno.workflow.id",
            "session.id", "user.id", "openinference.span.kind"}
        metric_keys = {"llm.token_count.prompt", "llm.token_count.completion", "llm.token_count.total"}
        for span in spans:
            attrs = {}
            for key, value in (span.attributes or {}).items():
                if key in id_keys and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", value):
                    attrs[key] = value
                elif key in metric_keys and isinstance(value, int) and value >= 0:
                    attrs[key] = value
            name = span.name if re.fullmatch(r"[A-Za-z0-9_. -]{1,100}", span.name) else "agno.operation"
            safe.append(ReadableSpan(name=name, context=span.context, parent=span.parent,
                resource=span.resource, attributes=attrs, events=(), links=(), kind=span.kind,
                status=Status(span.status.status_code), start_time=span.start_time, end_time=span.end_time))
        return super().export(safe)


def setup_metadata_tracing(db):
    # The dedicated process owns its tracer. No OTLP/network exporter is added.
    # A host which has already installed one must configure this deliberately.
    if isinstance(trace.get_tracer_provider(), TracerProvider):
        raise RuntimeError("agentos_tracing_already_configured")
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(MetadataOnlyExporter(db=db)))
    trace.set_tracer_provider(provider)
    AgnoInstrumentor().instrument(tracer_provider=provider)
    return provider
