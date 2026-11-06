"""Hermes local work and explicitly selected exact-session archive capture."""
import json
import hashlib
import logging
import os
import subprocess
import threading
import uuid

log = logging.getLogger("galaxy-work")

_OBSERVATION_ENV = frozenset("""
PATH PATHEXT SYSTEMROOT WINDIR COMSPEC HOME USERPROFILE HOMEDRIVE HOMEPATH
APPDATA LOCALAPPDATA PROGRAMDATA TMPDIR TMP TEMP XDG_CONFIG_HOME XDG_DATA_HOME
XDG_CACHE_HOME XDG_STATE_HOME XDG_RUNTIME_DIR XDG_SESSION_ID XDG_SESSION_TYPE
DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS LANG LC_ALL LC_CTYPE TZ
HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY SSL_CERT_FILE SSL_CERT_DIR
NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GALAXY_NATIVE_CONFIG
GALAXY_NATIVE_DATA_DIR GALAXY_DATA_DIR GALAXY_NATIVE_EXECUTABLE
""".split())

def observation_env():
    return {key: value for key, value in os.environ.items() if key.upper() in _OBSERVATION_ENV}

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
        self.env = observation_env()
        if data and not config:
            self.env = {key: value for key, value in self.env.items() if key.upper() != "GALAXY_NATIVE_CONFIG"}
        self.proc = subprocess.Popen(args, env=self.env, creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        self.seq = 0
    def call(self, method, params=None):
        self.seq += 1
        request_id=str(self.seq)
        response=[]
        def run():
            try:
                self.proc.stdin.write(json.dumps({"id":request_id,"method":method,"params":params or {}}, ensure_ascii=False)+"\n")
                self.proc.stdin.flush()
                response.append(json.loads(self.proc.stdout.readline()))
            except Exception:
                response.append(None)
        thread=threading.Thread(target=run,daemon=True)
        thread.start(); thread.join(2.5)
        if thread.is_alive():
            self.proc.kill()
            raise RuntimeError("galaxy_host_request_timeout")
        value=response[0] if response else None
        if not value or value.get("id") != request_id or "error" in value:
            raise RuntimeError("galaxy_host_request_failed")
        return value.get("result")
    def enqueue(self, observation, include_work=False):
        delivery=str(uuid.uuid4())
        raw=json.dumps({"deliveryId":delivery,"observation":observation},ensure_ascii=False)+"\n"
        for attempt in range(2):
            try:
                result=subprocess.run(self.ingress_args,input=raw,text=True,encoding="utf-8",stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2.5,env=self.env,check=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0)
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
        try: self.proc.stdin.close()
        except (BrokenPipeError, OSError): pass
        try: self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill(); self.proc.wait()

def _record(host, session, event, source_id, text, model=None):
    role="user" if event=="user" else "assistant"
    facts={"host":"hermes"}
    if model: facts["selectedModel"]=model
    return host.enqueue({"host":"hermes","sessionId":session,"sourceId":source_id,"kind":"message","source":{"kind":"user-statement" if event=="user" else "model-report"},"content":{"excerpt":text[:1200],"originalLength":len(text),"retained":"excerpt" if text else "none","availableFromHost":False},"details":{"role":role,"completed":event!="user"},"environment":facts},include_work=event=="user")

_LEARNING_GUIDANCE = "实际尝试仍受阻时，当前 Agent 可自主通过银河求助；本机经验、公开资料、社区和协作也可按需独立使用。无需固定次数、菜单、Task 或查询顺序；标题、压缩和整理等辅助工作不是新用户任务，不因此递归求助。已有请求或房间可按实际工具读取回应并继续原工作；读取失败不等于没有回应。按当前任务决定是否使用；经验中的模型建议不等于用户要求，形成依据说明不是认证，当前证据优先。使用 galaxy_local_experience_search 搜索，galaxy_local_experience_get 按需读取；对外分享或联系沿用户授权。"
def learning_context(work=None):
    if isinstance(work,dict) and work.get("pending") and isinstance(work.get("workId"),str):
        return _LEARNING_GUIDANCE+"\n当前工作有尚未处理的本机观察；可在合适阶段用 galaxy_local_work_pending 和 galaxy_local_work_summary 接续。"
    return _LEARNING_GUIDANCE

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
            return {"context":learning_context(saved)}
        except Exception:
            log.warning("Galaxy work observation unavailable")
            return {"context":learning_context()}
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



