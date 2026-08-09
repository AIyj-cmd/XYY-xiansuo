import asyncio, base64, sys, tempfile, types, unittest
from pathlib import Path
from unittest.mock import patch

from hermes_weixin_transport.account_manager import AccountManager, AccountManagerConfig, AccountVault, HermesPrimitiveProvider, _normalize_qr_status

class FakeProvider:
    def __init__(self): self.polls=[]; self.updates=[]; self.sends=[]
    async def create_qr(self): return {"qrToken":"qr-a","qrPayload":"fake-qr"}
    async def qr_status(self, _): return {"ilink_bot_id":"bot-a","ilink_bot_token":"token-a","base_url":"https://ilinkai.weixin.qq.com","status":"confirmed"}
    async def get_updates(self, account, token, base, cursor, lifecycle): self.polls.append((account,token,base,cursor,lifecycle)); return self.updates.pop(0) if self.updates else {"msgs":[],"get_updates_buf":cursor}
    async def send(self,*args): self.sends.append(args); return {"ret":0}

class AccountManagerTests(unittest.TestCase):
    def config(self, directory):
        return AccountManagerConfig("127.0.0.1",38999,str(directory),b"k"*32,"m"*32,"http://127.0.0.1:3000","s"*32,True)
    def test_disabled_manager_is_live_and_ready_but_never_polls_or_calls_provider(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider()
            manager=AccountManager(AccountManagerConfig("127.0.0.1",38117,str(directory),b"k"*32,"m"*32,"http://127.0.0.1:3000","s"*32),provider)
            self.assertEqual(manager.livez(),{"service":"hermes-account-manager","status":"live","enabled":False})
            with self.assertRaisesRegex(ValueError,"disabled"): manager.create({})
            manager.poll_once("hr_abcdefghijklmnopqrstuv"); manager.reconcile(); manager._start_poll("hr_abcdefghijklmnopqrstuv")
            self.assertEqual(provider.polls,[]); self.assertEqual(manager._threads,{})
    def test_encrypted_vault_capacity_and_tamper_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); vault=AccountVault(directory,b"k"*32)
            for i in range(10): vault.put({"accountRef":f"hr_{i:016d}xxxxxxxx","userId":i+1,"generation":1,"lifecycle":"prepared"})
            with self.assertRaises(ValueError): vault.put({"accountRef":"hr_zzzzzzzzzzzzzzzz","userId":11,"generation":1,"lifecycle":"prepared"})
            vault.put({"accountRef":"hr_rebindxxxxxxxxxxxx","userId":1,"generation":2,"lifecycle":"qr"})
            raw=vault.path.read_text(); self.assertNotIn('prepared',raw); vault.path.write_text(raw[:-2]+'xx'); vault.path.chmod(0o600)
            with self.assertRaises(Exception): vault.get("hr_0000000000000000xxxxxxxx")
    def test_pinned_upstream_qr_fields_are_mapped_exactly(self):
        self.assertEqual(_normalize_qr_status({"status":"confirmed","ilink_bot_id":"bot-a","bot_token":"token-a","baseurl":"https://ilinkai.weixin.qq.com"}),{
            "status":"confirmed","ilink_bot_id":"bot-a","ilink_bot_token":"token-a","base_url":"https://ilinkai.weixin.qq.com","redirect_host":""
        })
        aliases=_normalize_qr_status({"status":"confirmed","ilink_bot_id":"bot-a","ilink_bot_token":"wrong","base_url":"https://ilinkai.weixin.qq.com"})
        self.assertEqual(aliases["ilink_bot_token"],""); self.assertEqual(aliases["base_url"],"")
    def test_primitive_updates_normalize_real_items_filter_official_group_and_skip_active_text(self):
        modules={key:sys.modules.get(key) for key in ("gateway","gateway.platforms","gateway.platforms.weixin")}; calls=[]
        class Connector:
            async def close(self): calls.append("connector_closed")
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self,*_args): return False
        wx=types.ModuleType("gateway.platforms.weixin"); wx.LONG_POLL_TIMEOUT_MS=1000; wx._make_ssl_connector=lambda:Connector(); wx.aiohttp=types.SimpleNamespace(ClientSession=lambda **_kwargs:Session())
        def guess(message, account):
            calls.append(("guess",message.get("from_user_id"),account))
            return ("group","official-channel") if message.get("msg_type") == 1 and message.get("to_user_id") != account else ("dm",str(message.get("from_user_id") or ""))
        def extract(items): calls.append(("extract",items)); return items[0]["text_item"]["text"]
        wx._guess_chat_type=guess; wx._extract_text=extract
        async def updates(_session, **kwargs):
            calls.append(("get_updates",kwargs))
            return {"msgs":[
                {"from_user_id":"official-peer","to_user_id":"official-channel","msg_type":1,"context_token":"group-context","item_list":[{"type":1,"text_item":{"text":"确认 group"}}]},
                {"from_user_id":"wrong-account","to_user_id":"other-bot","msg_type":0,"context_token":"wrong-context","item_list":[{"type":1,"text_item":{"text":"确认 wrong"}}]},
                {"from_user_id":"dm-peer","to_user_id":"bot-a","context_token":"dm-context","item_list":[{"type":1,"text_item":{"text":"确认 exact"}}]},
            ],"get_updates_buf":"cursor-1"}
        wx._get_updates=updates; sys.modules["gateway"]=types.ModuleType("gateway"); sys.modules["gateway.platforms"]=types.ModuleType("gateway.platforms"); sys.modules["gateway.platforms.weixin"]=wx
        try:
            provider=HermesPrimitiveProvider(Path("/tmp"))
            prepared=asyncio.run(provider.get_updates("bot-a","token","https://ilinkai.weixin.qq.com","","prepared"))
            self.assertEqual(prepared,{"msgs":[{"from_user_id":"dm-peer","to_user_id":"bot-a","context_token":"dm-context","text":"确认 exact"}],"get_updates_buf":"cursor-1"})
            self.assertEqual(len([call for call in calls if isinstance(call,tuple) and call[0] == "extract"]),1)
            active=asyncio.run(provider.get_updates("bot-a","token","https://ilinkai.weixin.qq.com","cursor-1","active"))
            self.assertEqual(active,{"msgs":[{"from_user_id":"dm-peer","to_user_id":"bot-a","context_token":"dm-context"}],"get_updates_buf":"cursor-1"})
            self.assertEqual(len([call for call in calls if isinstance(call,tuple) and call[0] == "extract"]),1)
            self.assertIn(("guess","official-peer","bot-a"),calls)
            with tempfile.TemporaryDirectory() as root:
                directory=Path(root); directory.chmod(0o700); manager=AccountManager(self.config(directory),provider)
                manager.vault.put({"accountRef":"hr_abcdefghijklmnopqrstuv","attemptId":"12345678-1234-4234-a234-123456789012","userId":7,"generation":3,"lifecycle":"prepared","expiresAt":"2099-08-09 10:00:00","cursor":"","providerAccountId":"bot-a","token":"token-a","baseUrl":"https://ilinkai.weixin.qq.com","target":"","context":"","activationId":"exact"})
                with patch.object(manager,"_callback",return_value="accepted") as callback: manager.poll_once("hr_abcdefghijklmnopqrstuv"); callback.assert_called_once()
                activated=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert activated
                self.assertEqual((activated["lifecycle"],activated["target"],activated["context"],activated["cursor"]),("active","dm-peer","dm-context","cursor-1"))
        finally:
            for key,value in modules.items():
                if value is None: sys.modules.pop(key,None)
                else: sys.modules[key]=value
    def test_qr_render_failure_creates_no_vault_entry(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); manager=AccountManager(self.config(directory),FakeProvider())
            with patch("hermes_weixin_transport.account_manager._png_data",side_effect=ImportError("qrcode unavailable")):
                with self.assertRaises(ImportError): manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
            self.assertIsNone(manager.vault.get("hr_abcdefghijklmnopqrstuv"))
    @patch("hermes_weixin_transport.account_manager._png_data",return_value="data:image/png;base64,AA==")
    def test_scanned_state_and_redirect_host_are_fail_closed(self, _render):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            ref="hr_abcdefghijklmnopqrstuv"; request={"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":ref,"generation":3,"expiresAt":"2099-08-09 10:00:00"}
            manager.create(request)
            with patch.object(provider,"qr_status",return_value={"status":"scaned"}):
                self.assertEqual(manager.status(ref),{"status":"scanned"})
            with patch.object(provider,"qr_status",return_value={"status":"scaned_but_redirect","redirect_host":"evil.example"}):
                with self.assertRaisesRegex(ValueError,"provider host rejected"): manager.status(ref)
            retired=manager.vault.get(ref); assert retired
            self.assertEqual(retired["lifecycle"],"retired"); self.assertEqual(retired["token"],"")
    def test_fake_qr_confirm_requires_exact_command_and_account(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            with patch("hermes_weixin_transport.account_manager._png_data",lambda _:"data:image/png;base64,AA=="):
                created=manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
                self.assertEqual(created["status"],"waiting")
                persisted=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert persisted
                self.assertNotIn("qrToken",persisted); self.assertNotIn("qrPayload",persisted)
                with patch.object(manager,"_start_poll"): confirmed=manager.status("hr_abcdefghijklmnopqrstuv")
            entry=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert entry
            self.assertEqual(confirmed,{"status":"awaiting_context","confirmationCommand":f"确认 {entry['activationId']}"})
            manager.poll_once("hr_abcdefghijklmnopqrstuv")
            self.assertEqual(provider.polls[-1][0],"bot-a")
            self.assertEqual(provider.polls[-1][-1],"prepared")
            self.assertEqual(entry["lifecycle"],"prepared")
            self.assertNotIn("token-a",repr(confirmed))

    @patch("hermes_weixin_transport.account_manager._png_data",return_value="data:image/png;base64,AA==")
    def test_wrong_account_target_or_command_causes_zero_activation_or_send(self, _render):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
            with patch.object(manager,"_start_poll"): manager.status("hr_abcdefghijklmnopqrstuv")
            entry=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert entry
            provider.updates.append({"msgs":[{"to_user_id":"other-bot","from_user_id":"wrong","context_token":"ctx","text":f"确认 {entry['activationId']}"},{"to_user_id":"bot-a","from_user_id":"wrong","context_token":"ctx","text":f"确认 {entry['activationId']} "}],"get_updates_buf":"cursor-wrong"})
            with patch.object(manager,"_callback",return_value=True) as callback:
                manager.poll_once("hr_abcdefghijklmnopqrstuv")
                callback.assert_not_called()
            after=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert after
            self.assertEqual(after["lifecycle"],"prepared"); self.assertEqual(after["cursor"],"cursor-wrong"); self.assertEqual(provider.sends,[])

    @patch("hermes_weixin_transport.account_manager._png_data",return_value="data:image/png;base64,AA==")
    def test_exact_command_persists_context_before_callback_and_reconciles_after_crash(self, _render):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
            with patch.object(manager,"_start_poll"): manager.status("hr_abcdefghijklmnopqrstuv")
            entry=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert entry
            provider.updates.append({"msgs":[{"to_user_id":"bot-a","from_user_id":"target-a","context_token":"ctx-a","text":f"确认 {entry['activationId']}"}],"get_updates_buf":"cursor-a"})
            with patch.object(manager,"_callback",return_value=False): manager.poll_once("hr_abcdefghijklmnopqrstuv")
            prepared=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert prepared
            self.assertEqual((prepared["lifecycle"],prepared["target"],prepared["context"],prepared["cursor"]),("prepared","target-a","ctx-a","cursor-a"))
            with patch.object(manager,"_callback",return_value="accepted") as callback: manager.poll_once("hr_abcdefghijklmnopqrstuv"); callback.assert_called_once()
            self.assertEqual(manager.vault.get("hr_abcdefghijklmnopqrstuv")["lifecycle"],"active")

    @patch("hermes_weixin_transport.account_manager._png_data",return_value="data:image/png;base64,AA==")
    def test_expired_qr_is_not_refreshed(self, _render):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
            entry=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert entry
            entry["expiresAt"]="2000-08-09 10:00:00"; manager.vault.put(entry)
            self.assertEqual(manager.status("hr_abcdefghijklmnopqrstuv")["status"],"expired")
            self.assertEqual(provider.polls,[])
    @patch("hermes_weixin_transport.account_manager._png_data",return_value="data:image/png;base64,AA==")
    def test_prepared_attempt_expires_and_clears_credentials_without_polling(self, _render):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            manager.create({"id":"12345678-1234-4234-a234-123456789012","userId":7,"accountRef":"hr_abcdefghijklmnopqrstuv","generation":3,"expiresAt":"2099-08-09 10:00:00"})
            with patch.object(manager,"_start_poll"): manager.status("hr_abcdefghijklmnopqrstuv")
            entry=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert entry
            entry["expiresAt"]="2000-08-09 10:00:00"; manager.vault.put(entry); manager.poll_once("hr_abcdefghijklmnopqrstuv")
            retired=manager.vault.get("hr_abcdefghijklmnopqrstuv"); assert retired
            self.assertEqual(retired["lifecycle"],"expired"); self.assertEqual(retired["token"],""); self.assertEqual(provider.polls,[])
    def test_active_rebind_retires_old_account_atomically_and_stale_authorization_retires(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            old={"accountRef":"hr_oldabcdefghijklmnop","attemptId":"12345678-1234-4234-a234-123456789011","userId":7,"generation":1,"lifecycle":"active","expiresAt":"2099-08-09 10:00:00","cursor":"c","providerAccountId":"old-bot","token":"old-token","baseUrl":"https://ilinkai.weixin.qq.com","target":"old-target","context":"old-context","activationId":"12345678-1234-4234-a234-123456789011"}
            new={"accountRef":"hr_newabcdefghijklmnop","attemptId":"12345678-1234-4234-a234-123456789012","userId":7,"generation":2,"lifecycle":"prepared","expiresAt":"2099-08-09 10:00:00","cursor":"c","providerAccountId":"new-bot","token":"new-token","baseUrl":"https://ilinkai.weixin.qq.com","target":"new-target","context":"new-context","activationId":"12345678-1234-4234-a234-123456789012"}
            manager.vault.put(old); manager.vault.put(new)
            with patch.object(manager,"_callback",return_value="accepted"): manager.poll_once(new["accountRef"])
            self.assertEqual(manager.vault.get(new["accountRef"])["lifecycle"],"active")
            retired=manager.vault.get(old["accountRef"]); assert retired
            self.assertEqual(retired["lifecycle"],"retired"); self.assertEqual(retired["token"],"")
            manager._last_auth[new["accountRef"]]=0
            with patch.object(manager,"_callback",return_value="rejected"): manager.poll_once(new["accountRef"])
            self.assertEqual(manager.vault.get(new["accountRef"])["lifecycle"],"retired")
    def test_unknown_account_never_polls_or_sends(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); provider=FakeProvider(); manager=AccountManager(self.config(directory),provider)
            manager.poll_once("hr_abcdefghijklmnopqrstuv")
            self.assertEqual(provider.polls,[])
