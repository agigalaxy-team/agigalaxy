"""Hermes local work and explicitly selected exact-session archive capture."""
import json
import hashlib
import logging
import os
import subprocess
import uuid

log = logging.getLogger("galaxy-work")

class Host:
    def __init__(self, ctx):
        exe = ctx.get_config("executable", os.environ.get("GALAXY_NATIVE_EXECUTABLE"))
        config = ctx.get_config("config", os.environ.get("GALAXY_NATIVE_CONFIG"))
        data = ctx.get_config("data_directory", os.environ.get("GALAXY_NATIVE_DATA_DIR"))
        if not exe:
            raise RuntimeError("galaxy_executable_unavailable")
        args = [exe, "host" if config else "integration-host"]
        if config: args += ["--config", config]
        elif data: args += ["--data-dir", data]
        self.ingress_args = [exe, "ingress"] + (["--config", config] if config else (["--data-dir", data] if data else []))
        self.env = os.environ.copy()
        if data and not config: self.env.pop("GALAXY_NATIVE_CONFIG", None)
        self.proc = subprocess.Popen(args, env=self.env, creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        self.seq = 0
    def call(self, method, params=None):
        self.seq += 1
        self.proc.stdin.write(json.dumps({"id":str(self.seq),"method":method,"params":params or {}}, ensure_ascii=False)+"\n")
        self.proc.stdin.flush()
        response=json.loads(self.proc.stdout.readline())
        if response.get("id") != str(self.seq) or "error" in response:
            raise RuntimeError("galaxy_host_request_failed")
        return response.get("result")
    def enqueue(self, observation, include_work=False):
        delivery=str(uuid.uuid4())
        raw=json.dumps({"deliveryId":delivery,"observation":observation},ensure_ascii=False)+"\n"
        for attempt in range(2):
            try:
                result=subprocess.run(self.ingress_args,input=raw,text=True,encoding="utf-8",stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,env=self.env,check=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0)
                accepted=json.loads(result.stdout)
                if accepted.get("queued") is True and accepted.get("deliveryId")==delivery: break
            except Exception:
                if attempt: raise
        else: raise RuntimeError("host_ingress_unavailable")
        self.call("history.drainIngress")
        if not include_work: return None
        owner=self.call("history.identity")
        if not owner: return None
        result=self.call("history.get",{"galaxyId":owner["id"],"host":"hermes","sessionId":observation["sessionId"],"limit":1})
        return result.get("work") if result else None
    def close(self):
        self.proc.stdin.close()
        try: self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill(); self.proc.wait()

def _record(host, session, event, source_id, text, model=None):
    role="user" if event=="user" else "assistant"
    facts={"host":"hermes"}
    if model: facts["selectedModel"]=model
    return host.enqueue({"host":"hermes","sessionId":session,"sourceId":source_id,"kind":"message","source":{"kind":"user-statement" if event=="user" else "model-report"},"content":{"excerpt":text[:1200],"originalLength":len(text),"retained":"excerpt" if text else "none","availableFromHost":False},"details":{"role":role,"completed":event!="user"},"environment":facts},include_work=event=="user")

def register(ctx):
    archive_offsets = {}
    def capture_selected(host, session_id):
        settings=host.call("archive.settings")
        owner=settings.get("galaxyId") if settings else None
        selection=settings.get("settings",{}) if settings else {}
        selected=owner and selection.get("enabled") and any(item.get("host")=="hermes" and item.get("sessionId")==session_id for item in selection.get("sessions",[]))
        if not selected:
            for key in list(archive_offsets):
                if key[1]==session_id: archive_offsets.pop(key,None)
            return
        # Hermes owns this database and resolves its current profile. No writer,
        # cross-profile discovery, ancestor expansion or unselected read is used.
        from hermes_state import SessionDB
        db=SessionDB(read_only=True)
        key=(owner,session_id)
        try:
            offset=archive_offsets.get(key,0)
            while True:
                current=host.call("archive.settings")
                selected=current and current.get("galaxyId")==owner and current.get("settings",{}).get("enabled") and any(item.get("host")=="hermes" and item.get("sessionId")==session_id for item in current["settings"].get("sessions",[]))
                if not selected: return
                rows=db.get_messages(session_id,include_inactive=False,include_compacted=True,limit=50,offset=offset,include_ancestors=False)
                if not rows: return
                for row in rows:
                    if row.get("session_id")!=session_id or row.get("id") is None: return
                    record_id="hermes-record:"+hashlib.sha256(json.dumps([session_id,row["id"]],ensure_ascii=False,separators=(",",":")).encode("utf-8")).hexdigest()
                    parts=row.get("content") if isinstance(row.get("content"),list) else []
                    result=host.call("archive.captureMessage",{"galaxyId":owner,"host":"hermes","sessionId":session_id,"messageId":record_id,"message":row,"parts":parts})
                    if not result or not (result.get("captured") or result.get("reason")=="outside-selected-retention"): return
                    offset+=1;archive_offsets[key]=offset
                if len(rows)<50: return
        finally: db.close()
    def finish(host,session_id):
        if not host: return
        try: capture_selected(host,session_id)
        except Exception: log.warning("Galaxy selected conversation capture unavailable")
        finally:
            try: host.close()
            except Exception: log.warning("Galaxy host connection close unavailable")
    def record_user(session_id, user_message, model=None, turn_id=None, **kwargs):
        if not isinstance(session_id,str): return
        host=None
        try:
            host=Host(ctx)
            saved=_record(host,session_id,"user","prompt:"+str(turn_id or uuid.uuid4()),user_message,model) if isinstance(user_message,str) else None
            if saved and saved.get("pending") and isinstance(saved.get("workId"),str):
                return {"context":"银河已积累当前工作的待整理本机观察。当前 Agent 可在自然阶段用 galaxy_local_work_pending 和 galaxy_local_work_summary 按需整理；工作引用 "+json.dumps(saved["workId"],ensure_ascii=False)+"。"}
        except Exception: log.warning("Galaxy work observation unavailable")
        finally:
            finish(host,session_id)
    def record_tool(session_id=None, tool_name=None, tool_call_id=None, status=None, **kwargs):
        if not isinstance(session_id,str) or not isinstance(tool_call_id,str) or not tool_call_id: return
        host=None
        try:
            host=Host(ctx)
            host.enqueue({"host":"hermes","sessionId":session_id,"sourceId":"tool:"+tool_call_id,"kind":"tool","source":{"kind":"tool-report","eventId":tool_call_id},"details":{"tool":str(tool_name or "")[:160],"status":str(status or "unknown")[:80],"workOutcome":"unknown"}})
        except Exception: log.warning("Galaxy tool observation unavailable")
        finally:
            finish(host,session_id)
    def record_assistant(session_id, assistant_response, model=None, turn_id=None, **kwargs):
        if not isinstance(session_id,str) or not isinstance(assistant_response,str): return
        host=None
        try:
            host=Host(ctx); _record(host,session_id,"assistant","assistant:"+str(turn_id or uuid.uuid4()),assistant_response,model)
        except Exception: log.warning("Galaxy work observation unavailable")
        finally:
            finish(host,session_id)
    def capture_turn_end(session_id=None, **kwargs):
        if not isinstance(session_id,str) or not session_id: return
        host=None
        try: host=Host(ctx)
        except Exception: log.warning("Galaxy host connection unavailable")
        finally: finish(host,session_id)
    ctx.register_hook("post_tool_call",record_tool)
    ctx.register_hook("pre_llm_call",record_user)
    ctx.register_hook("post_llm_call",record_assistant)
    ctx.register_hook("on_session_end",capture_turn_end)



