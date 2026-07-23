from __future__ import annotations

import json
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server


class LiveServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        server.STORE = server.RoomStore()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.LiveHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def request(self, method: str, path: str, payload: dict | None = None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if body else {}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def test_health_and_static_page(self) -> None:
        status, payload = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/")
        response = connection.getresponse()
        body = response.read().decode()
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertIn("局域直播与语音协作", body)

    def test_room_join_and_directed_signal(self) -> None:
        status, host = self.request("POST", "/api/rooms", {"name": "Host"})
        self.assertEqual(status, 201)
        self.assertTrue(host["isHost"])
        code = host["roomCode"]

        status, guest = self.request("POST", f"/api/rooms/{code}/join", {"name": "Guest"})
        self.assertEqual(status, 200)
        self.assertEqual(len(guest["participants"]), 2)

        status, _ = self.request(
            "POST",
            f"/api/rooms/{code}/signal",
            {
                "clientId": host["clientId"],
                "to": guest["clientId"],
                "data": {"channel": "voice", "candidate": {"candidate": "test"}},
            },
        )
        self.assertEqual(status, 200)

        status, events = self.request(
            "GET",
            f"/api/rooms/{code}/events?clientId={guest['clientId']}&since={guest['sequence']}",
        )
        self.assertEqual(status, 200)
        self.assertEqual(events["events"][0]["type"], "signal")
        self.assertEqual(events["events"][0]["payload"]["from"], host["clientId"])

    def test_unknown_room_is_rejected(self) -> None:
        status, payload = self.request("POST", "/api/rooms/ABC234/join", {"name": "Guest"})
        self.assertEqual(status, 404)
        self.assertIn("房间不存在", payload["error"])


if __name__ == "__main__":
    unittest.main()
