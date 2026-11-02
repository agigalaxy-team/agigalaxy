from agno.agent import Agent
from agno.db.postgres import PostgresDb
from agno.os import AgentOS, Authorization, QueueConfig
from agno.run.base import RunContext
from agno.utils.log import set_log_level_to_warning

from .authorization import GalaxyAuthorization
from .gateway import GalaxyGateway
from .model_gate import with_current_authority
from .model_settings import configured_domains, domain_model, model_settings_view
from .p13_strategies import create_p13_workflow, publish_fixed_p13_definition
from .p13_strategy_tools import strategy_tools
from .selected_content import create_prepared_review, selected_content_tools
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
                tools=[*selected_content_tools(gateway, current), *strategy_tools(gateway)] if domain == "governance" else [],
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

    review = create_prepared_review(db, gateway, current)
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
