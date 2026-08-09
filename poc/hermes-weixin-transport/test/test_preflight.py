import base64, json, os, sys, tempfile, types, unittest
from pathlib import Path
from unittest.mock import patch

from hermes_weixin_transport.preflight import run_dry_run, run_preflight


class PreflightTests(unittest.TestCase):
    def _paths(self, root: Path) -> tuple[Path, Path, Path, Path]:
        vault=root/"vault"; ledger=root/"ledger"; state=root/"state"
        for directory in (vault,ledger,state): directory.mkdir(mode=0o700); directory.chmod(0o700)
        secret=root/"gateway.secret"; secret.write_text("g"*32); secret.chmod(0o600)
        return vault,ledger,state,secret
    def _environment(self, ledger: Path, state: Path, secret: Path) -> dict[str,str]:
        return {"ILINK_POC_TRANSPORT":"hermes","ILINK_GATEWAY_HOST":"127.0.0.1","ILINK_GATEWAY_PORT":"38116","ILINK_POC_LIVE_ENABLED":"false","ILINK_HERMES_TRANSPORT_ENABLED":"false","ILINK_POC_STATE_DIR":str(ledger),"ILINK_HERMES_STATE_DIR":str(state),"ILINK_GATEWAY_SECRET_FILE":str(secret)}
    def test_preflight_requires_fixed_loopback_ports_and_all_real_switches_false(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root); directory.chmod(0o700); vault,ledger,state,secret=self._paths(directory)
            config=directory/"manager.json"; config.write_text(json.dumps({"host":"127.0.0.1","port":38117,"vault_dir":str(vault),"vault_key":base64.b64encode(b"k"*32).decode(),"manager_secret":"m"*32,"server_url":"http://127.0.0.1:3000","internal_secret":"i"*32,"enabled":False})); config.chmod(0o600)
            with patch.dict(os.environ,self._environment(ledger,state,secret),clear=False), patch.dict(sys.modules,{"qrcode":types.ModuleType("qrcode")}), patch("hermes_weixin_transport.preflight._node_version",return_value="v22.13.0"), patch("hermes_weixin_transport.preflight.importlib.import_module"):
                result=run_preflight(config,Path(os.environ["HERMES_SOURCE_DIR"]))
            self.assertEqual(result["status"],"ready"); self.assertFalse(result["managerEnabled"])
    def test_dry_run_creates_only_disabled_temporary_config_and_restores_environment(self):
        before=os.environ.get("ILINK_POC_LIVE_ENABLED")
        observed={}
        def fake_preflight(config: Path, _source: Path):
            raw=json.loads(config.read_text()); observed.update(raw); self.assertEqual(os.environ["ILINK_POC_LIVE_ENABLED"],"false")
            return {"checks":{"upstream":"ok","imports":"ok","config":"ok","vault":"ok","switches":"ok"}}
        with patch("hermes_weixin_transport.preflight.run_preflight",side_effect=fake_preflight):
            result=run_dry_run(Path("/fixed-source"))
        self.assertEqual(result["status"],"dry_run_ok"); self.assertFalse(observed["enabled"]); self.assertEqual(os.environ.get("ILINK_POC_LIVE_ENABLED"),before)
