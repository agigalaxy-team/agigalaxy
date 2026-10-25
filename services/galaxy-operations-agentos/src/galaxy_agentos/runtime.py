import json
from uuid import UUID

from agno.agent import Agent
from agno.db.postgres import PostgresDb
from agno.os import AgentOS, Authorization, QueueConfig
from agno.run.base import RunContext
from agno.workflow import Workflow, Step
from agno.workflow.types import HumanReview, StepInput, StepOutput
from agno.utils.log import set_log_level_to_warning

from .authorization import GalaxyAuthorization
from .gateway import AuthorityDenied, GalaxyGateway
from .model_gate import with_current_authority
from .model_settings import configured_domains, domain_model, model_settings_view
from .p13_strategies import create_p13_workflow, publish_fixed_p13_definition
from .p13_strategy_tools import strategy_tools
from .conversations import conversation_agents
from .duties import duty_factory
from .duty_deadline import MAX_ROUND_SECONDS

DOMAINS = {"overview": "运营概览", "governance": "公开内容治理", "messaging": "消息运营",
    "discovery": "发现与使用分析", "maintenance": "运行维护"}


def database(settings):
    return PostgresDb(db_url=settings.database_url, db_schema=settings.database_schema, id="galaxy-agentos")


def create_runtime(settings, *, gateway=None, model_factory=None, p13_analyst_factory=None, duty_model_factory=None, db=None, tracing=True):
    set_log_level_to_warning()
    db = db or database(settings)
    gateway = gateway or GalaxyGateway(settings)
    tracer = None
    if tracing:
        from .tracing import setup_metadata_tracing
        tracer = setup_metadata_tracing(db)

    def current(run_context: RunContext):
        return gateway.authorize(run_context.user_id, operation="run")

    def read_selected_content(run_context: RunContext, target_kind: str, target_id: str) -> str:
        """Read one explicitly selected, currently readable public post or reply."""
        if target_kind not in {"post", "reply"}:
            raise AuthorityDenied("agentos_tool_arguments_invalid")
        UUID(target_id)
        result = gateway.tool(run_context.user_id, "read-selected-content",
            {"kind": target_kind, "id": target_id}, run_id=run_context.run_id,
            call_id="read:" + target_kind + ":" + target_id)
        return json.dumps(result, ensure_ascii=False)

    def selected_objects(run_context: RunContext) -> str:
        """List the current task's explicitly authorized public object IDs."""
        row = current(run_context)["execution"]
        return json.dumps({"resourceIds": row["resourceIds"], "actions": row["actions"]})

    def search_selected_public_content(run_context: RunContext, target_kind: str,
            query: str, after: int = 0, limit: int = 20) -> str:
        """Locate current public posts/replies within this task's selected IDs.

        Returns identifiers, not snippets. Read a result through
        read_selected_content before using its current source text.
        """
        if target_kind not in {"post", "reply"}:
            raise AuthorityDenied("agentos_tool_arguments_invalid")
        result = gateway.tool(run_context.user_id, "search-selected-public-content",
            {"kind": target_kind, "query": query, "after": after, "limit": limit},
            run_id=run_context.run_id, call_id="selected-public-search")
        return json.dumps(result, ensure_ascii=False)

    def authorized_run(run_context: RunContext):
        current(run_context)

    agents = []
    # A test may inject Agno's Model abstraction explicitly. Production has no
    # fabricated fallback and never lets Agent choose its implicit OpenAI model.
    active_domains = frozenset(DOMAINS) if model_factory is not None else configured_domains(settings)
    configured = bool(active_domains)
    if configured:
        for domain, label in DOMAINS.items():
            if domain not in active_domains:
                continue
            selected_model = with_current_authority(model_factory(), gateway) if model_factory is not None else domain_model(settings, domain, gateway)
            selected_model._galaxy_usage_database = db
            agents.append(Agent(id="galaxy-" + domain, name=label, model=selected_model, db=db,
                tools=[selected_objects, search_selected_public_content, read_selected_content, *strategy_tools(gateway)] if domain == "governance" else [],
                pre_hooks=[authorized_run], post_hooks=[authorized_run],
                instructions=["你是银河工作台的" + label + "助手。只处理当前明确任务。",
                    "事实与权限以银河工具的当前结果为准，不猜测未记录数据或执行来源。",
                    "确定性统计、分页、版本、幂等和权限由代码完成。没有工具就说明无法读取。",
                    "不处理私聊或案件材料；不将公告、系统邮件用于画像和推荐。",
                    "不要声称已经执行未实际返回成功的操作。需要处置时准备明确建议，由受控操作完成。",
                    "普通策略只可通过选定策略工具，按人工明确的参数范围、主导方式与日常启停权限调整；无范围或重要变更交人工。",
                    "不能修改共同目标、领域目标、授权边界或模型配置。策略草稿已保存不代表已发布，旧事项仍按绑定版本。"],
                add_history_to_context=True, num_history_runs=10,
                store_tool_messages=False, store_media=False,
                metadata={"promptVersion": "galaxy-operations-v1", "domain": domain},
                enable_agentic_memory=False, update_memory_on_run=False,
                store_events=True, telemetry=False, debug_mode=False))

    def prepare(step_input: StepInput, run_context: RunContext) -> StepOutput:
        result = current(run_context)
        if not result.get("execution", {}).get("hasPreparedCommand"):
            raise AuthorityDenied("agentos_prepared_command_required")
        return StepOutput(content={"executionId": result["execution"]["id"], "state": "awaiting-human"})

    def execute(step_input: StepInput, run_context: RunContext) -> StepOutput:
        # No command/body/role is taken from the workflow input or approval JSON.
        # The server-frozen command still checks latest authority, source and CAS.
        current(run_context)
        result = gateway.tool(run_context.user_id, "execute-prepared-command", {},
            run_id=run_context.run_id, call_id="prepared-command")
        return StepOutput(content=result)

    review = Workflow(id="galaxy-prepared-review", name="核对并执行已准备操作", db=db, store_events=True,
        steps=[Step(name="核对当前任务", executor=prepare),
            Step(name="确认并执行", executor=execute,
                human_review=HumanReview(requires_confirmation=True))], telemetry=False)
    strategy_workflow = create_p13_workflow(db=db, gateway=gateway, settings=settings, analyst_factory=p13_analyst_factory)
    strategy_definition = publish_fixed_p13_definition(db, strategy_workflow)
    agents.extend(conversation_agents(settings=settings, db=db, gateway=gateway,
        domains=DOMAINS, active_domains=active_domains, model_factory=model_factory))
    # Registered even while models/plans are disabled. Its claim-time factory
    # loads the task's current authority and human binding without a restart.
    agents.append(duty_factory(settings=settings, db=db, gateway=gateway, model_factory=duty_model_factory))
    os = AgentOS(id="galaxy-operations", name="Galaxy Operations", version="0.1.0", db=db,
        agents=agents, workflows=[review, strategy_workflow],
        authorization=Authorization(verification_keys=[settings.verification_key], algorithm="HS256",
            verify_audience=True, audience=settings.audience, issuer=settings.issuer,
            authorization_provider=GalaxyAuthorization(gateway),
            # These exact private metadata routes use the outer service-key
            # gate. Do not reinterpret that credential as an execution JWT.
            excluded_route_paths=["/galaxy/runs", "/galaxy/runs/*", "/galaxy/model-settings", "/galaxy/p13-strategies/*", "/galaxy/autonomy/*"]),
        user_isolation=True, queue=QueueConfig(durable=True, db=db, max_attempts=1, max_concurrency=2,
            timeout_seconds=MAX_ROUND_SECONDS),
        tracing=False, telemetry=False, scheduler=False)
    return {"os": os, "db": db, "gateway": gateway, "agents": agents, "review": review, "strategyWorkflow": strategy_workflow, "strategyDefinition": strategy_definition, "strategyModelConfigured": p13_analyst_factory is not None or 'governance' in active_domains,
        "tracer": tracer, "modelConfigured": configured, "configuredDomains": active_domains,
        "modelSettings": model_settings_view(settings)}
