import json
import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_stats.server import make_server, project_overview


class StubStore:
    def query(self, filters):
        if filters.get("start") == "bad":
            raise ValueError("无效时间")
        if filters.get("project") == "with-turns":
            return {"filters": filters, "summary": {"tool_calls": 1}, "turns": [
                {"id": "t1", "tools": [{"call_id": "a", "output_bytes": 4}],
                 "evidence": [{"line": 2}], "usage_records": [{"usage": {}}]}]}
        return {"filters": filters, "summary": {"token_total": None}}

    def detail(self, identity, filters=None):
        return {"session": {"id": identity}, "turns": []} if identity == "known" else None

    def import_paths(self, paths, instance):
        return {"paths": paths, "instance": instance}


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(StubStore(), ["synthetic"], 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%s" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, data=None, headers=None):
        request = Request(self.base + path, data=data, headers=headers or {})
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.headers, response.read()
        except HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def test_filters_and_missing(self):
        status, _, body = self.request("/api/overview?model=synthetic&start=2026-01-01T00%3A00%3A00Z")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["filters"]["model"], "synthetic")
        self.assertIsNone(json.loads(body)["summary"]["token_total"])
        self.assertEqual(self.request("/api/session?id=missing")[0], 404)
        self.assertEqual(self.request("/api/overview?start=bad")[0], 400)

    def test_no_remote_origin_or_host(self):
        self.assertEqual(self.request("/api/overview", headers={"Host": "evil.invalid"})[0], 403)
        self.assertEqual(self.request("/api/overview", headers={"Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.request("/api/refresh", b"{}", {"Origin": "https://evil.invalid", "Content-Type": "application/json"})[0], 403)

    def test_refresh_is_fixed_source_and_json_only(self):
        status, _, body = self.request("/api/refresh", b'{"paths":["/not-allowed"]}', {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["paths"], ["synthetic"])
        self.assertEqual(self.request("/api/refresh", b"{}")[0], 415)
        self.assertEqual(self.request("/api/refresh", b"bad", {"Content-Type": "application/json"})[0], 400)

    def test_static_and_traversal(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"<html", body.lower())
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        assets = re.findall(rb'(?:src|href)="(/assets/[^\"]+)"', body)
        self.assertTrue(assets, 'React production assets must be built before testing')
        for asset in assets:
            asset_status, asset_headers, asset_body = self.request(asset.decode())
            self.assertEqual(asset_status, 200)
            self.assertTrue(asset_body)
            self.assertIn('text/', asset_headers['Content-Type'])
        self.assertEqual(self.request("/../README.md")[0], 404)
        self.assertEqual(self.request("/assets/../../README.md")[0], 404)
        self.assertEqual(self.request("/assets/missing.js")[0], 404)


    def test_overview_projects_turn_execution_detail(self):
        status, _, body = self.request("/api/overview?project=with-turns")
        self.assertEqual(status, 200)
        turn = json.loads(body)["turns"][0]
        self.assertEqual(turn["tools_count"], 1)
        self.assertEqual(turn["tool_output_bytes"], 4)
        self.assertNotIn("tools", turn)
        self.assertNotIn("evidence", turn)
        self.assertNotIn("usage_records", turn)


class OverviewProjectionTests(unittest.TestCase):
    def test_keeps_counts_and_known_tool_output_bytes(self):
        result = {"summary": {"turns": 1}, "turns": [{
            "id": "known", "token_total": 10,
            "tools": [{"call_id": "a", "output_bytes": 5}, {"call_id": "b", "output_bytes": 7}],
            "evidence": [{"line": 3}], "usage_records": [{"usage": {"input_tokens": 4}}]}]}
        projected = project_overview(result)
        turn = projected["turns"][0]
        self.assertEqual(projected["summary"], {"turns": 1})
        self.assertEqual(turn["token_total"], 10)
        self.assertEqual(turn["tools_count"], 2)
        self.assertEqual(turn["tool_output_bytes"], 12)
        self.assertNotIn("tools", turn)
        self.assertNotIn("evidence", turn)
        self.assertNotIn("usage_records", turn)
        self.assertEqual(result["turns"][0]["tools"][0]["call_id"], "a")

    def test_unknown_or_empty_tool_sizes_stay_unknown(self):
        turns = [
            {"id": "unknown", "tools": [{"output_bytes": 5}, {"output_bytes": None}]},
            {"id": "empty", "tools": []},
            {"id": "missing"},
            {"id": "boolean", "tools": [{"output_bytes": True}]},
        ]
        projected = project_overview({"turns": turns})
        for turn in projected["turns"]:
            self.assertIsNone(turn["tool_output_bytes"])
        self.assertEqual([turn["tools_count"] for turn in projected["turns"]], [2, 0, 0, 1])

    def test_non_overview_payloads_pass_through(self):
        self.assertIsNone(project_overview(None))
        self.assertEqual(project_overview({"error": "x"}), {"error": "x"})
        self.assertEqual(project_overview({"turns": "bad"}), {"turns": "bad"})
        self.assertEqual(project_overview({"turns": ["raw"]})["turns"], ["raw"])


class CountingStore:
    """Counts query calls and reports an optional database file for cache keys."""

    def __init__(self, path=None):
        self.path = path
        self.calls = 0
        self.lock = threading.Lock()

    def query(self, filters):
        with self.lock:
            self.calls += 1
            calls = self.calls
        return {"filters": filters, "summary": {"sessions": calls}, "turns": []}

    def detail(self, identity, filters=None):
        return {"session": {"id": identity}, "turns": []}

    def import_paths(self, paths, instance):
        return {"paths": paths, "instance": instance}


class OverviewCacheTests(unittest.TestCase):
    def serve(self, store):
        server = make_server(store, [], 0, archive_only=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return "http://127.0.0.1:%s" % server.server_port

    def fetch(self, base, query):
        with urlopen(base + "/api/overview?" + query, timeout=3) as response:
            return response.status, json.loads(response.read())

    def test_reuses_response_until_database_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "stats.sqlite3"
            database.write_text("db", encoding="utf-8")
            store = CountingStore(database)
            base = self.serve(store)
            status, first = self.fetch(base, "model=a")
            self.assertEqual(status, 200)
            _, second = self.fetch(base, "model=a")
            self.assertEqual(store.calls, 1)
            self.assertEqual(second, first)
            _, other = self.fetch(base, "model=b")
            self.assertEqual(store.calls, 2)
            self.assertNotEqual(other["summary"], first["summary"])
            stamp = time.time_ns() + 10_000_000
            os.utime(database, ns=(stamp, stamp))
            _, refreshed = self.fetch(base, "model=a")
            self.assertEqual(store.calls, 3)
            self.assertEqual(refreshed["summary"]["sessions"], 3)

    def test_store_without_a_database_file_is_never_cached(self):
        store = CountingStore(None)
        base = self.serve(store)
        self.fetch(base, "model=a")
        self.fetch(base, "model=a")
        self.assertEqual(store.calls, 2)


if __name__ == "__main__":
    unittest.main()
