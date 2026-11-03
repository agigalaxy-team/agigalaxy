import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AgentCard, Task, Message, TaskState, Role } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';

export async function sdkPeer() {
  const endpoint = 'https://peer.example.org/a2a';
  const requests = [];
  const contexts = new Map();
  const card = AgentCard.fromJSON({ name: 'Official SDK fixture peer', version: 'fixture',
    description: 'Synthetic local interoperability fixture.',
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'fixture' }],
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] });
  const taskStore = new InMemoryTaskStore();
  let userName = 'external-fixture-user';
  const executor = {
    async execute(ctx, bus) {
      contexts.set(ctx.taskId, { contextId: ctx.contextId, context: ctx.context });
      const command = ctx.userMessage.parts[0]?.content?.value;
      const parts = [{ text: `Peer reply: ${command}`, mediaType: 'text/plain' }];
      if (command === 'message') {
        bus.publish(AgentEvent.message(Message.fromJSON({ messageId: randomUUID(), contextId: ctx.contextId,
          role: Role.ROLE_AGENT, parts })));
        return;
      }
      const states = { work: TaskState.TASK_STATE_WORKING, input: TaskState.TASK_STATE_INPUT_REQUIRED,
        auth: TaskState.TASK_STATE_AUTH_REQUIRED, fail: TaskState.TASK_STATE_FAILED, reject: TaskState.TASK_STATE_REJECTED };
      const state = states[command] ?? TaskState.TASK_STATE_COMPLETED;
      const task = Task.fromJSON({ id: ctx.taskId, contextId: ctx.contextId,
        status: { state, message: { messageId: randomUUID(), role: Role.ROLE_AGENT, parts } },
        artifacts: state === TaskState.TASK_STATE_COMPLETED ? [{ artifactId: randomUUID(), name: 'fixture result',
          parts: [...parts, { url: 'https://artifact.example.org/result?synthetic=signed-url', mediaType: 'application/json' }] }] : [] });
      bus.publish(AgentEvent.task(task));
    },
    async cancelTask(taskId, bus) {
      const ctx = contexts.get(taskId);
      bus.publish(AgentEvent.task(Task.fromJSON({ id: taskId, contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_CANCELED } })));
      bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(card, taskStore, executor, undefined, undefined, undefined, undefined, undefined,
    { keepBusAliveStates: [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED] });
  const rpc = new JsonRpcTransportHandler(handler);
  const server = createServer(async (req, res) => {
    try {
      if(req.method==='GET'&&req.url==='/.well-known/agent-card.json'){
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(AgentCard.toJSON(card)));return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, version: req.headers['a2a-version'], authorization: req.headers.authorization });
      const response = await rpc.handle(body, new ServerCallContext({ requestedVersion: req.headers['a2a-version'],
        tenant: body.params?.tenant, user: { isAuthenticated: true, userName } }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(500); res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { endpoint, card: AgentCard.toJSON(card), requests,
    async get(url){if(url!=='https://peer.example.org/.well-known/agent-card.json')throw new Error('Unexpected card URL');
      return (await fetch(`http://127.0.0.1:${server.address().port}/.well-known/agent-card.json`)).json();},
    setUser: value => { userName = value; },
    async complete(taskId) {
      const ctx = contexts.get(taskId);
      const task = await taskStore.load(taskId, ctx.context);
      task.status.state = TaskState.TASK_STATE_COMPLETED;
      await taskStore.save(task, ctx.context);
    },
    async post(url, { bodyJson, credential, signal }) {
      if (url !== endpoint) throw new Error('Unexpected test endpoint.');
      const response = await fetch(`http://127.0.0.1:${server.address().port}/a2a`, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: bodyJson });
      return response.json();
    },
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
