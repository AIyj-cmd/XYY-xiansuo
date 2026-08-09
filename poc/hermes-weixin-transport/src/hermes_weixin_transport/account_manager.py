"""Loopback-only, QR-only Hermes account manager.

This module intentionally imports only the fixed upstream's low-level iLink
helpers.  It never calls ``qr_login`` (which renders stdout, refreshes QR codes
and writes Hermes' account JSON).  All provider state is kept in the encrypted
external vault below; no Agent, reply, typing, media or model path exists.
"""
from __future__ import annotations

import asyncio, base64, fcntl, hashlib, hmac, io, json, os, re, secrets, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .security import ensure_state_directory, open_private_lock, require_private_file

_REF = re.compile(r"^hr_[A-Za-z0-9_-]{16,96}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"

def _sha(value: str) -> str: return hashlib.sha256(value.encode()).hexdigest()
def _peer_fingerprint(value: str) -> str: return hashlib.sha256(b"xiansuo/hermes-peer/v1\0" + value.encode()).hexdigest()

def _normalize_qr_status(data: Any) -> dict[str,str]:
    """Map the pinned upstream's actual QR response without accepting aliases."""
    if not isinstance(data,dict): raise ValueError("qr status invalid")
    return {
        "status":str(data.get("status") or ""),
        "ilink_bot_id":str(data.get("ilink_bot_id") or ""),
        "ilink_bot_token":str(data.get("bot_token") or ""),
        "base_url":str(data.get("baseurl") or ""),
        "redirect_host":str(data.get("redirect_host") or ""),
    }

class AccountProvider(Protocol):
    async def create_qr(self) -> dict[str, str]: ...
    async def qr_status(self, qr_token: str) -> dict[str, str]: ...
    async def get_updates(self, account_id: str, token: str, base_url: str, cursor: str) -> dict[str, Any]: ...
    async def send(self, account_id: str, token: str, base_url: str, target: str, context: str, text: str, client_id: str) -> dict[str, Any]: ...

class AccountVault:
    """Encrypted, MACed and flock-protected multi-account vault (0700/0600)."""
    def __init__(self, directory: str | Path, key: bytes):
        if len(key) < 32: raise ValueError("vault key too short")
        self.directory, self.key = Path(directory), key
        self.path, self.lock_path = self.directory / "accounts.vault", self.directory / "accounts.lock"
    def _crypt(self, nonce: bytes, data: bytes) -> bytes:
        stream=b""; n=0
        while len(stream) < len(data): stream += hmac.new(self.key,b"account-stream\0"+nonce+n.to_bytes(8,"big"),hashlib.sha256).digest(); n+=1
        return bytes(a ^ b for a,b in zip(data,stream))
    def _locked(self):
        ensure_state_directory(self.directory); fd=open_private_lock(self.lock_path); fcntl.flock(fd,fcntl.LOCK_EX); return fd
    def _load(self) -> dict[str, Any]:
        if not self.path.exists(): return {"schema":1,"entries":{},"nonces":{}}
        require_private_file(self.path,kind="Hermes account vault")
        raw=json.loads(self.path.read_text())
        if not isinstance(raw,dict) or raw.get("schema") != 1 or not isinstance(raw.get("entries"),dict) or not isinstance(raw.get("nonces"),dict): raise ValueError("vault integrity")
        return raw
    def _save(self, raw: dict[str,Any]) -> None:
        fd,name=tempfile.mkstemp(prefix=".accounts.",dir=self.directory)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,"w") as out: json.dump(raw,out,sort_keys=True,separators=(",",":")); out.flush(); os.fsync(out.fileno())
            os.replace(name,self.path); require_private_file(self.path,kind="Hermes account vault")
            directory_fd=os.open(self.directory,os.O_RDONLY | getattr(os,"O_DIRECTORY",0))
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        finally:
            try: os.unlink(name)
            except FileNotFoundError: pass
    def _decode(self, raw: dict[str,Any], ref: str) -> dict[str,Any] | None:
        item=raw["entries"].get(ref)
        if not isinstance(item,dict): return None
        nonce,cipher,tag=item.get("nonce"),item.get("ciphertext"),item.get("tag")
        if not all(isinstance(x,str) for x in (nonce,cipher,tag)): raise ValueError("vault integrity")
        expected=hmac.new(self.key,f"{ref}\0{nonce}\0{cipher}".encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,tag): raise ValueError("vault integrity")
        value=json.loads(self._crypt(base64.b64decode(nonce),base64.b64decode(cipher)).decode())
        if not isinstance(value,dict) or value.get("accountRef") != ref: raise ValueError("vault integrity")
        return value
    def _encode(self, raw: dict[str,Any], ref: str, value: dict[str,Any]) -> None:
        nonce=os.urandom(32); cipher=base64.b64encode(self._crypt(nonce,json.dumps(value,separators=(",",":"),sort_keys=True).encode())).decode(); nonce64=base64.b64encode(nonce).decode()
        raw["entries"][ref]={"nonce":nonce64,"ciphertext":cipher,"tag":hmac.new(self.key,f"{ref}\0{nonce64}\0{cipher}".encode(),hashlib.sha256).hexdigest()}
    def put(self, value: dict[str,Any]) -> None:
        ref=value.get("accountRef")
        if not isinstance(ref,str) or not _REF.fullmatch(ref) or value.get("lifecycle") not in {"qr","prepared","active","retired","expired"}: raise ValueError("account entry invalid")
        if not isinstance(value.get("userId"),int) or value["userId"] < 1 or not isinstance(value.get("generation"),int) or value["generation"] < 1: raise ValueError("account entry invalid")
        fd=self._locked()
        try:
            raw=self._load(); existing=self._decode(raw,ref)
            live=[entry for key in raw["entries"] if (entry:=self._decode(raw,key)) and entry.get("lifecycle") in {"qr","prepared","active"}]
            live_users={entry.get("userId") for entry in live}
            if existing is None and value["userId"] not in live_users and len(live_users)>=10: raise ValueError("vault capacity")
            self._encode(raw,ref,value); self._save(raw)
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    def activate_exclusive(self, ref: str) -> None:
        """Activate one account and retire every older live account for its user.

        The transition is one flock-protected atomic vault replacement, so a
        rebind can never leave two account-local delivery paths active.
        """
        fd=self._locked()
        try:
            raw=self._load(); current=self._decode(raw,ref)
            if not current or current.get("lifecycle") != "prepared": raise ValueError("account entry invalid")
            user_id=current.get("userId")
            for other_ref in list(raw["entries"]):
                other=self._decode(raw,other_ref)
                if not other or other_ref == ref or other.get("userId") != user_id or other.get("lifecycle") not in {"qr","prepared","active"}: continue
                other.update({"lifecycle":"retired","providerAccountId":"","token":"","baseUrl":"","target":"","context":"","cursor":"","activationId":""})
                self._encode(raw,other_ref,other)
            current["lifecycle"]="active"; self._encode(raw,ref,current); self._save(raw)
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    def get(self, ref: str) -> dict[str,Any] | None:
        if not _REF.fullmatch(ref): return None
        fd=self._locked()
        try: return self._decode(self._load(),ref)
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    def entries(self) -> list[dict[str,Any]]:
        fd=self._locked()
        try: raw=self._load(); return [entry for ref in raw["entries"] if (entry:=self._decode(raw,ref)) is not None]
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
    def consume_nonce(self, nonce: str, expires_ms: int) -> bool:
        if not 16 <= len(nonce) <= 128: return False
        fd=self._locked()
        try:
            raw=self._load(); now=int(time.time()*1000); raw["nonces"]={key:value for key,value in raw["nonces"].items() if isinstance(value,int) and value>now}
            key=_sha("xiansuo/hermes-manager/nonce/v1\0"+nonce)
            if key in raw["nonces"] or len(raw["nonces"])>=10000: return False
            raw["nonces"][key]=expires_ms; self._save(raw); return True
        finally: fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)

class HermesPrimitiveProvider:
    """Adapter over pinned v2026.8.3 primitives, with no upstream persistence."""
    def __init__(self, source_root: Path):
        import sys, importlib
        if str(source_root) not in sys.path: sys.path.insert(0,str(source_root))
        self.wx=importlib.import_module("gateway.platforms.weixin")
    async def create_qr(self) -> dict[str,str]:
        wx=self.wx; connector=wx._make_ssl_connector()
        try:
            async with wx.aiohttp.ClientSession(connector=connector,trust_env=False) as session:
                data=await wx._api_get(session,base_url=wx.ILINK_BASE_URL,endpoint=f"{wx.EP_GET_BOT_QR}?bot_type=3",timeout_ms=wx.QR_TIMEOUT_MS)
        finally:
            if connector is not None: await connector.close()
        token=str(data.get("qrcode") or ""); payload=str(data.get("qrcode_img_content") or token)
        if not token or not payload: raise ValueError("qr unavailable")
        return {"qrToken":token,"qrPayload":payload}
    async def qr_status(self, qr_token: str) -> dict[str,str]:
        wx=self.wx; connector=wx._make_ssl_connector()
        try:
            async with wx.aiohttp.ClientSession(connector=connector,trust_env=False) as session:
                data=await wx._api_get(session,base_url=wx.ILINK_BASE_URL,endpoint=f"{wx.EP_GET_QR_STATUS}?qrcode={qr_token}",timeout_ms=wx.QR_TIMEOUT_MS)
        finally:
            if connector is not None: await connector.close()
        return _normalize_qr_status(data)
    async def get_updates(self, account_id:str, token:str, base_url:str, cursor:str)->dict[str,Any]:
        wx=self.wx; connector=wx._make_ssl_connector()
        try:
            async with wx.aiohttp.ClientSession(connector=connector,trust_env=False) as session: return await wx._get_updates(session,base_url=base_url,token=token,sync_buf=cursor,timeout_ms=wx.LONG_POLL_TIMEOUT_MS)
        finally:
            if connector is not None: await connector.close()
    async def send(self, account_id:str, token:str, base_url:str, target:str, context:str, text:str, client_id:str)->dict[str,Any]:
        wx=self.wx; connector=wx._make_ssl_connector()
        try:
            async with wx.aiohttp.ClientSession(connector=connector,trust_env=False) as session: return await wx._send_message(session,base_url=base_url,token=token,to=target,text=text,context_token=context,client_id=client_id)
        finally:
            if connector is not None: await connector.close()

def _png_data(value: str) -> str:
    """Never return a provider URL. Rendering failure is a fail-closed QR failure."""
    import qrcode
    image=qrcode.make(value); out=io.BytesIO(); image.save(out,format="PNG")
    return "data:image/png;base64,"+base64.b64encode(out.getvalue()).decode()

@dataclass(frozen=True)
class AccountManagerConfig:
    host: str; port: int; vault_dir: str; vault_key: bytes; manager_secret: str; server_url: str; internal_secret: str

class AccountManager:
    def __init__(self, config: AccountManagerConfig, provider: AccountProvider):
        self.config,self.vault,self.provider=config,AccountVault(config.vault_dir,config.vault_key),provider
        self.stop=threading.Event(); self._threads: dict[str,threading.Thread]={}
        # QR payload/token are deliberately process-memory only. A manager
        # crash invalidates the five-minute attempt instead of persisting QR.
        self._qr: dict[str,tuple[str,str,str]]={}; self._runtime_lock=threading.RLock(); self._last_auth: dict[str,float]={}
    def _response(self, entry:dict[str,Any], include_qr:bool=False)->dict[str,Any]:
        status="waiting" if entry["lifecycle"]=="qr" else "awaiting_context" if entry["lifecycle"]=="prepared" else "active" if entry["lifecycle"]=="active" else "expired" if entry["lifecycle"]=="expired" else "cancelled"
        result={"status":status}
        if include_qr and status=="waiting" and entry["accountRef"] in self._qr: result["qrDataUrl"]=self._qr[entry["accountRef"]][2]
        if status=="prepared": result["confirmationCommand"]=f"确认 {entry['activationId']}"
        return result
    def create(self, request:dict[str,Any])->dict[str,Any]:
        ref=request.get("accountRef"); ident=request.get("id"); gen=request.get("generation"); user=request.get("userId")
        if not isinstance(ref,str) or not _REF.fullmatch(ref) or not isinstance(ident,str) or not _UUID.fullmatch(ident) or not isinstance(gen,int) or gen<1 or not isinstance(user,int) or user<1: raise ValueError("invalid request")
        with self._runtime_lock:
            self.expire_stale()
            if self.vault.get(ref): raise ValueError("attempt exists")
            try: expires=datetime.strptime(str(request.get("expiresAt")),"%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone(timedelta(hours=8)))
            except ValueError as exc: raise ValueError("invalid request") from exc
            if expires <= datetime.now(timezone(timedelta(hours=8))): raise ValueError("invalid request")
            qr=asyncio.run(self.provider.create_qr())
            if not isinstance(qr.get("qrToken"),str) or not qr["qrToken"] or not isinstance(qr.get("qrPayload"),str) or not qr["qrPayload"]: raise ValueError("qr unavailable")
            qr_data_url=_png_data(qr["qrPayload"])
            entry={"accountRef":ref,"attemptId":ident,"userId":user,"generation":gen,"lifecycle":"qr","expiresAt":request.get("expiresAt"),"cursor":"","providerAccountId":"","token":"","baseUrl":"","target":"","context":"","activationId":""}
            self.vault.put(entry); self._qr[ref]=(qr["qrToken"],qr["qrPayload"],qr_data_url); return self._response(entry,True)
    def status(self, ref:str)->dict[str,Any]:
        with self._runtime_lock:
            entry=self.vault.get(ref)
            if not entry: raise ValueError("not found")
            if self._expired(entry): self._retire(ref,"expired"); return {"status":"expired"}
            if entry["lifecycle"]=="qr":
                qr=self._qr.get(ref)
                if not qr: self._retire(ref,"expired"); return {"status":"expired"}
                result=asyncio.run(self.provider.qr_status(qr[0]))
                provider_status=result.get("status","")
                if provider_status == "wait": return self._response(entry,True)
                if provider_status == "scaned": return {"status":"scanned"}
                if provider_status == "scaned_but_redirect":
                    if result.get("redirect_host") != "ilinkai.weixin.qq.com":
                        self._retire(ref); raise ValueError("provider host rejected")
                    return {"status":"scanned"}
                if provider_status == "expired":
                    self._retire(ref,"expired"); return {"status":"expired"}
                if provider_status != "confirmed":
                    self._retire(ref); raise ValueError("qr status invalid")
                account,token=result.get("ilink_bot_id",""),result.get("ilink_bot_token","")
                base_url=result.get("base_url") or _ILINK_BASE_URL
                if not account or not token or base_url != _ILINK_BASE_URL:
                    self._retire(ref); raise ValueError("provider credential rejected")
                entry.update({"lifecycle":"prepared","providerAccountId":account,"token":token,"baseUrl":base_url,"activationId":secrets.token_hex(16)[:8]+"-"+secrets.token_hex(16)[:4]+"-4"+secrets.token_hex(16)[:3]+"-a"+secrets.token_hex(16)[:3]+"-"+secrets.token_hex(16)[:12]}); self.vault.put(entry); self._start_poll(entry["accountRef"])
                self._qr.pop(ref,None)
            return self._response(entry,True)
    def cancel(self,ref:str)->None:
        with self._runtime_lock: self._retire(ref)
    def _retire(self,ref:str,lifecycle:str="retired")->None:
        entry=self.vault.get(ref); self._qr.pop(ref,None); self._last_auth.pop(ref,None)
        if entry:
            entry.update({"lifecycle":lifecycle,"providerAccountId":"","token":"","baseUrl":"","target":"","context":"","cursor":"","activationId":""}); self.vault.put(entry)
    def _expired(self,entry:dict[str,Any])->bool:
        if entry.get("lifecycle") not in {"qr","prepared"}: return False
        try: return datetime.now(timezone(timedelta(hours=8))) >= datetime.strptime(str(entry.get("expiresAt")),"%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone(timedelta(hours=8)))
        except ValueError: return True
    def expire_stale(self)->None:
        for entry in self.vault.entries():
            if self._expired(entry): self._retire(str(entry["accountRef"]),"expired")
    def _callback(self,entry:dict[str,Any])->str:
        body=json.dumps({"id":entry["attemptId"],"accountRef":entry["accountRef"],"targetFingerprint":_peer_fingerprint(str(entry["target"])),"activationId":entry["activationId"]},separators=(",",":")).encode(); ts=str(int(time.time()*1000)); nonce=secrets.token_urlsafe(24); canonical="\n".join(("POST","/internal/hermes-accounts/activate",ts,nonce,hashlib.sha256(body).hexdigest())); headers={"content-type":"application/json","x-hermes-timestamp":ts,"x-hermes-nonce":nonce,"x-hermes-signature":hmac.new(self.config.internal_secret.encode(),canonical.encode(),hashlib.sha256).hexdigest()}
        try:
            with urlopen(Request(self.config.server_url.rstrip("/")+"/internal/hermes-accounts/activate",body,headers),timeout=10) as response: return "accepted" if json.loads(response.read()).get("code")==0 else "rejected"
        except HTTPError as exc: return "rejected" if exc.code == 409 else "unavailable"
        except Exception: return "unavailable"
    def poll_once(self,ref:str)->None:
        entry=self.vault.get(ref)
        if not entry or entry.get("lifecycle") not in {"prepared","active"}: return
        if self._expired(entry): self._retire(ref,"expired"); return
        if entry["lifecycle"]=="active" and time.monotonic()-self._last_auth.get(ref,0)>=60:
            authorized=self._callback(entry)
            if authorized=="rejected": self._retire(ref); return
            if authorized=="accepted": self._last_auth[ref]=time.monotonic()
        if entry["lifecycle"]=="prepared" and entry.get("target") and entry.get("context"):
            authorized=self._callback(entry)
            if authorized=="accepted": self.vault.activate_exclusive(ref); self._last_auth[ref]=time.monotonic(); return
            if authorized=="rejected": self._retire(ref); return
        try: response=asyncio.run(self.provider.get_updates(str(entry["providerAccountId"]),str(entry["token"]),str(entry["baseUrl"]),str(entry.get("cursor") or "")))
        except Exception: return
        for item in response.get("msgs",[]) if isinstance(response.get("msgs"),list) else []:
            if not isinstance(item,dict) or item.get("to_user_id") != entry["providerAccountId"] or item.get("room_id") or item.get("chat_room_id"): continue
            target,context,text=item.get("from_user_id"),item.get("context_token"),item.get("text")
            if not isinstance(target,str) or not isinstance(context,str) or not context or not isinstance(text,str): continue
            if entry["lifecycle"]=="prepared" and text == f"确认 {entry['activationId']}":
                entry.update({"target":target,"context":context,"cursor":str(response.get("get_updates_buf") or entry.get("cursor") or "")})
                self.vault.put(entry)
                authorized=self._callback(entry)
                if authorized=="accepted": self.vault.activate_exclusive(ref); self._last_auth[ref]=time.monotonic(); return
                if authorized=="rejected": self._retire(ref); return
            elif entry["lifecycle"]=="active" and target == entry.get("target"):
                entry.update({"context":context,"cursor":str(response.get("get_updates_buf") or entry.get("cursor") or "")}); self.vault.put(entry)
        cursor=response.get("get_updates_buf")
        if isinstance(cursor,str) and cursor and cursor != entry.get("cursor"):
            entry["cursor"]=cursor; self.vault.put(entry)
    def _start_poll(self,ref:str)->None:
        if ref in self._threads and self._threads[ref].is_alive(): return
        def runner():
            while not self.stop.is_set(): self.poll_once(ref); time.sleep(.25)
        self._threads[ref]=threading.Thread(target=runner,daemon=True); self._threads[ref].start()
    def reconcile(self)->None:
        self.expire_stale()
        for entry in self.vault.entries():
            if entry.get("lifecycle") in {"prepared","active"}: self._start_poll(str(entry["accountRef"]))

def load_account_manager_config(path: str | Path) -> AccountManagerConfig:
    """Read one external 0600 JSON file; secrets are never accepted in argv/env."""
    try: raw=json.loads(require_private_file(Path(path),kind="account manager 配置").read_text())
    except Exception as exc: raise ValueError("account manager 配置无效") from exc
    required={"host","port","vault_dir","vault_key","manager_secret","server_url","internal_secret"}
    if not isinstance(raw,dict) or set(raw)!=required: raise ValueError("account manager 配置字段无效")
    if raw["host"] not in {"127.0.0.1","::1"} or not isinstance(raw["port"],int) or not 1024<=raw["port"]<=65535: raise ValueError("account manager 仅允许 loopback")
    if not isinstance(raw["vault_dir"],str) or not raw["vault_dir"].startswith("/") or not isinstance(raw["server_url"],str) or not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}",raw["server_url"]): raise ValueError("account manager 路径无效")
    try: key=base64.b64decode(raw["vault_key"],validate=True)
    except Exception as exc: raise ValueError("account manager vault key 无效") from exc
    if len(key)<32 or any(not isinstance(raw[k],str) or len(raw[k].encode())<32 for k in ("manager_secret","internal_secret")): raise ValueError("account manager 密钥无效")
    ensure_state_directory(Path(raw["vault_dir"]))
    return AccountManagerConfig(raw["host"],raw["port"],raw["vault_dir"],key,raw["manager_secret"],raw["server_url"],raw["internal_secret"])

def serve_manager(manager:AccountManager)->ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args:Any)->None: pass
        def _send(self,status:int,data:dict[str,Any])->None: self.send_response(status); self.send_header("content-type","application/json"); self.send_header("cache-control","no-store"); self.end_headers(); self.wfile.write(json.dumps(data,separators=(",",":")).encode())
        def _auth(self,body:bytes)->bool:
            if self.client_address[0] not in {"127.0.0.1","::1"}: return False
            ts=self.headers.get("x-hermes-manager-timestamp",""); nonce=self.headers.get("x-hermes-manager-nonce",""); sig=self.headers.get("x-hermes-manager-signature","")
            if not re.fullmatch(r"\d{13}",ts) or abs(int(ts)-int(time.time()*1000))>60000: return False
            canonical="\n".join((self.command,self.path,ts,nonce,hashlib.sha256(body).hexdigest())); expected=hmac.new(manager.config.manager_secret.encode(),canonical.encode(),hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected,sig) and manager.vault.consume_nonce(nonce,int(ts)+65000)
        def _body(self)->bytes:
            size=int(self.headers.get("content-length","0")); return self.rfile.read(size) if 0<=size<=16384 else b""
        def do_POST(self):
            body=self._body()
            if self.path!="/qr-attempts" or not self._auth(body): return self._send(401,{"code":"AUTH"})
            try: self._send(200,manager.create(json.loads(body)))
            except Exception: self._send(409,{"code":"REJECTED"})
        def do_GET(self):
            body=b""
            if not self.path.startswith("/qr-attempts/") or not self._auth(body): return self._send(401,{"code":"AUTH"})
            try: self._send(200,manager.status(self.path.rsplit("/",1)[1]))
            except Exception: self._send(404,{"code":"NOT_FOUND"})
        def do_DELETE(self):
            body=self._body()
            if not self.path.startswith("/qr-attempts/") or not self._auth(body): return self._send(401,{"code":"AUTH"})
            try: manager.cancel(self.path.rsplit("/",1)[1]); self._send(200,{"status":"cancelled"})
            except Exception: self._send(404,{"code":"NOT_FOUND"})
    server=ThreadingHTTPServer((manager.config.host,manager.config.port),Handler); manager.reconcile(); return server
