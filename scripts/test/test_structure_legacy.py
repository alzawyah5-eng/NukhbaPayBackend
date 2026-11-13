"""Keep the pre-existing structure assertions executable independently of the JS graph audit."""
import ast
import contextlib
import io
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch
from subprocess import CompletedProcess

CHECKER = Path(__file__).resolve().parents[1] / "check_structure.py"
TREE = ast.parse(CHECKER.read_text(encoding="utf-8"))
REQUIRED = next(ast.literal_eval(node.value) for node in TREE.body
                if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "REQUIRED" for target in node.targets))


class ExistingStructureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nukh-legacy-structure-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in REQUIRED:
            self.put(name, "{}" if name.endswith(".json") else "")
        for name, package in [("package.json", "nukhbapay"), ("apps/api/package.json", "@nukhbapay/api"),
                              ("apps/worker/package.json", "@nukhbapay/worker"), ("apps/admin-web/package.json", "@nukhbapay/admin-web")]:
            self.put(name, json.dumps({"name": package}))
        self.put("packages/contracts/public/quote.schema.json", json.dumps({"additionalProperties": False, "properties": {}}))
        self.put("scripts/check_structure.py", CHECKER.read_text(encoding="utf-8"))

    def put(self, name, text):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")

    def check(self):
        output = io.StringIO()
        code = 0
        # Only the separately tested Node graph subprocess is mocked. The actual
        # Python inventory/package/domain/public/client assertions run unchanged.
        with patch("subprocess.run", return_value=CompletedProcess([], 0, "", "")), contextlib.redirect_stdout(output):
            try:
                runpy.run_path(str(self.root / "scripts/check_structure.py"), run_name="__main__")
            except SystemExit as error:
                code = error.code
        return code, output.getvalue()

    def rejects(self, marker):
        code, output = self.check()
        self.assertEqual(code, 1)
        self.assertIn(marker, output)

    def test_valid_inventory_still_passes(self):
        self.assertEqual(self.check()[0], 0)

    def test_missing_required_file_rejects(self):
        (self.root / "README.md").unlink()
        self.rejects("Missing required file")

    def test_package_name_rejects(self):
        self.put("apps/api/package.json", json.dumps({"name": "wrong"}))
        self.rejects("Unexpected project package name")

    def test_legacy_dependency_rejects(self):
        self.put("apps/api/package.json", json.dumps({"name": "@nukhbapay/api", "dependencies": {"@nukhabapay/application": "workspace:*"}}))
        self.rejects("Legacy workspace dependency")

    def test_invalid_json_rejects(self):
        self.put("fixtures/malformed.json", "{broken")
        self.rejects("Invalid JSON")

    def test_unspecified_public_fields_reject(self):
        self.put("packages/contracts/public/quote.schema.json", json.dumps({"additionalProperties": True}))
        self.rejects("Public schema permits unspecified fields")

    def test_private_financial_fields_reject(self):
        self.put("packages/contracts/public/quote.schema.json", json.dumps({"additionalProperties": False, "properties": {"provider_cost": {}}}))
        self.rejects("Private fields in public schema")

    def test_backend_application_import_rejects(self):
        self.put("packages/example/src/example.ts", "import x from '@nukhbapay/api';")
        self.rejects("Backend package imports an app")

    def test_domain_infrastructure_import_rejects(self):
        self.put("packages/domain/src/pricing.ts", "import x from 'node:fs';")
        self.rejects("Domain imports infrastructure")

    def test_mobile_and_kiosk_backend_imports_reject(self):
        for client in ("mobile", "kiosk-client"):
            with self.subTest(client=client):
                self.put(f"apps/{client}/src/component.tsx", "import x from '@nukhbapay/application';")
                self.rejects("Client imports backend package")
                shutil.rmtree(self.root / f"apps/{client}/src")


if __name__ == "__main__":
    unittest.main()
