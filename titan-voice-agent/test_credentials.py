"""Synthetic credential/config tests; stdlib only, no SDK, model, container or network."""
import ast
import os
from pathlib import Path
import subprocess
import sys
import unittest

from validate_livekit import validate_livekit_credentials

ROOT = Path(__file__).resolve().parent
KEY = "synthetic_operator_key"
SECRET = "synthetic_operator_secret_0123456789abcdef"


class CredentialTests(unittest.TestCase):
    def test_rejects_missing_shared_malformed_short_and_oversize(self):
        pairs = [(None, None), ("devkey", "secret"), (KEY, "short"),
                 ("short", SECRET), (KEY + "\n", SECRET), (KEY, SECRET + ":"),
                 (KEY + '"', SECRET), ("a" * 129, SECRET), (KEY, "b" * 257),
                 (12345678, SECRET), (KEY, SECRET + " ")]
        for key, secret in pairs:
            with self.subTest(case=pairs.index((key, secret))):
                with self.assertRaisesRegex(ValueError, "Configure private") as error:
                    validate_livekit_credentials({"LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret})
                self.assertNotIn(SECRET, str(error.exception))

    def test_accepts_valid_minimum_maximum_numeric_and_operator_pairs(self):
        for key, secret in [(KEY, SECRET), ("12345678", "1" * 32), ("a" * 128, "b" * 256)]:
            with self.subTest(lengths=(len(key), len(secret))):
                self.assertIsNone(validate_livekit_credentials({"LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret}))

    def test_cli_fails_closed_and_never_echoes_values(self):
        for valid in [False, True]:
            env = {"PATH": os.defpath, "LIVEKIT_API_KEY": KEY, "LIVEKIT_API_SECRET": SECRET if valid else SECRET + ":"}
            result = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "validate_livekit.py")], env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0 if valid else 1)
            self.assertNotIn(KEY, result.stdout + result.stderr)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            self.assertIn("passed" if valid else "Configure private", result.stdout + result.stderr)

    def test_agent_validates_before_sdk_and_model_imports_and_keeps_health_loopback(self):
        tree = ast.parse((ROOT / "agent.py").read_text())
        call = next(node for node in tree.body if isinstance(node, ast.Expr)
                    and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                    and node.value.func.id == "validate_livekit_credentials")
        imported = [node for node in tree.body if isinstance(node, ast.ImportFrom)
                    and (node.module.startswith("livekit") or node.module == "kokoro_tts")]
        self.assertTrue(imported)
        self.assertTrue(all(node.lineno > call.lineno for node in imported))
        server = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                      and isinstance(node.func, ast.Name) and node.func.id == "AgentServer")
        self.assertEqual(next(item.value.value for item in server.keywords if item.arg == "host"), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
