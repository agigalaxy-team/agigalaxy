# Deployment template, not an activated service

`compose.yaml` is a single private native LiteLLM service. It introduces no
database, Redis, budget platform, model provider or public proxy route.

The templates are intentionally incomplete: `runtime.env.example` and
`agentos.env.example` contain empty new service credentials. They must not be
used as production runtime files. Root coordinates any activation and creates
the new key outside the workspace. No existing user/provider key is needed.

Protected candidate paths are `/etc/galaxy/model-gateway/runtime.env` and
`/etc/galaxy/model-gateway/models.yaml`. The latter must initially be the supplied
`services/galaxy-model-gateway/config/models.empty.yaml`. File ownership must
permit only the service runtime to read its mounted configuration and the
operator to change it; do not widen existing credential ACLs. Mount AgentOS's
shipped `/app/model-bindings.empty.json` or a separately protected copy, with all
five values null. The supplied AgentOS image does not enable a model by itself.

Set GALAXY_MODEL_GATEWAY_IMAGE and GALAXY_AGENTOS_IMAGE to explicitly built images for the source revision being reviewed. The template does not select a historical image tag or describe the active runtime; do not retag an existing active image. Building the two tags does not activate or replace the
running AgentOS. No database migration, existing service restart, model call or
credential change is part of this build.

Read the service README's **AI-agent deployment** section before integration.
Run the service-specific checks needed for changed code together at the end of a development batch; reuse existing results for unchanged inputs. Model binding, HTTP transport, native database and actual provider behavior are separate evidence.
