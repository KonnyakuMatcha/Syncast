from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server


class RoomLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.store = server.RoomStore()
        self.room, self.host = self.store.create('Host')
        _, self.guest = self.store.join(self.room.code, 'Guest')

    def test_active_host_request_removes_stale_guest(self):
        self.guest.last_seen = time.time() - server.PARTICIPANT_TTL_SECONDS - 1
        self.store.authenticate(self.room.code, self.host.client_id, self.host.session_token)
        self.assertNotIn(self.guest.client_id, self.room.participants)
        self.assertEqual(self.room.events[-1]['type'], 'participant-left')

    def test_expired_session_cannot_revive_itself(self):
        self.guest.last_seen = time.time() - server.PARTICIPANT_TTL_SECONDS - 1
        with self.assertRaises(PermissionError):
            self.store.authenticate(self.room.code, self.guest.client_id, self.guest.session_token)

    def test_room_expiration_is_enforced_on_existing_sessions(self):
        self.room.created_at = time.time() - server.ROOM_TTL_SECONDS - 1
        with self.assertRaises(PermissionError):
            self.store.authenticate(self.room.code, self.host.client_id, self.host.session_token)
        self.assertNotIn(self.room.code, self.store.rooms)
        self.assertEqual(self.room.events[-1]['type'], 'room-closed')

    def test_new_room_creation_cleans_abandoned_rooms(self):
        self.host.last_seen = time.time() - server.PARTICIPANT_TTL_SECONDS - 1
        self.store.create('New host')
        self.assertNotIn(self.room.code, self.store.rooms)

    def test_room_capacity_and_slot_reuse(self):
        for index in range(server.MAX_PARTICIPANTS - 2):
            self.store.join(self.room.code, f'Guest {index}')
        with self.assertRaises(ValueError):
            self.store.join(self.room.code, 'Overflow')
        self.store.leave(self.room.code, self.guest.client_id, self.guest.session_token)
        self.store.join(self.room.code, 'Replacement')
        self.assertEqual(len(self.room.participants), server.MAX_PARTICIPANTS)

    def test_host_departure_closes_room(self):
        self.store.leave(self.room.code, self.host.client_id, self.host.session_token)
        self.assertNotIn(self.room.code, self.store.rooms)
        self.assertEqual(self.room.events[-1]['type'], 'room-closed')
        with self.assertRaises(PermissionError):
            self.store.authenticate(self.room.code, self.guest.client_id, self.guest.session_token)


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

    def request(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        token: str = "",
    ):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if body else {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
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
        self.assertIn("点对点直播与语音协作", body)
        self.assertIn('href="styles.css"', body)
        self.assertIn('src="app.js"', body)
        self.assertIn('id="topology-map"', body)
        self.assertNotIn('href="/styles.css"', body)
        self.assertIn('<option value="high" selected>高帧 · 1080p60</option>', body)
        self.assertIn('id="topology-mode"', body)
        self.assertIn('src="topology.js"', body)
        quality_options = body.split('id="quality-select"', 1)[1].split('</select>', 1)[0]
        self.assertNotIn('<option value="auto">', quality_options)

    def test_room_join_and_directed_signal(self) -> None:
        status, host = self.request("POST", "/api/rooms", {"name": "Host"})
        self.assertEqual(status, 201)
        self.assertTrue(host["isHost"])
        code = host["roomCode"]

        status, guest = self.request(
            "POST",
            f"/api/rooms/{code}/join",
            {"name": "Guest", "relayCapable": False},
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(guest["participants"]), 2)
        guest_public = next(item for item in guest["participants"] if item["id"] == guest["clientId"])
        self.assertFalse(guest_public["relayCapable"])

        status, _ = self.request(
            "POST",
            f"/api/rooms/{code}/signal",
            {
                "clientId": host["clientId"],
                "to": guest["clientId"],
                "data": {"channel": "voice", "candidate": {"candidate": "test"}},
            },
            host["sessionToken"],
        )
        self.assertEqual(status, 200)

        status, events = self.request(
            "GET",
            f"/api/rooms/{code}/events?clientId={guest['clientId']}&since={guest['sequence']}",
            token=guest["sessionToken"],
        )
        self.assertEqual(status, 200)
        self.assertEqual(events["events"][0]["type"], "signal")
        self.assertEqual(events["events"][0]["payload"]["from"], host["clientId"])

    def test_unknown_room_is_rejected(self) -> None:
        status, payload = self.request("POST", "/api/rooms/ABC234/join", {"name": "Guest"})
        self.assertEqual(status, 404)
        self.assertIn("房间不存在", payload["error"])

    def test_public_client_id_cannot_be_used_as_authentication(self) -> None:
        _, host = self.request("POST", "/api/rooms", {"name": "Host"})
        _, guest = self.request(
            "POST", f"/api/rooms/{host['roomCode']}/join", {"name": "Guest"}
        )
        status, _ = self.request(
            "POST",
            f"/api/rooms/{host['roomCode']}/signal",
            {
                "clientId": host["clientId"],
                "to": guest["clientId"],
                "data": {"channel": "member-state", "muted": True},
            },
        )
        self.assertEqual(status, 401)

    def test_ice_configuration_uses_expiring_turn_credentials(self) -> None:
        environment = {
            "RTC_STUN_URLS": "stun:rtc.example.com:3478",
            "RTC_TURN_URLS": "turn:rtc.example.com:3478?transport=udp,turn:rtc.example.com:3478?transport=tcp",
            "RTC_TURN_SECRET": "test-secret",
            "RTC_TURN_TTL": "3600",
        }
        with patch.dict(server.os.environ, environment, clear=True):
            ice_servers = server.build_ice_servers("client-123")
        self.assertEqual(ice_servers[0]["urls"], ["stun:rtc.example.com:3478"])
        self.assertEqual(len(ice_servers[1]["urls"]), 2)
        self.assertTrue(ice_servers[1]["username"].endswith(":client-123"))
        self.assertNotEqual(ice_servers[1]["credential"], environment["RTC_TURN_SECRET"])

    def test_authenticated_ice_refresh(self) -> None:
        environment = {
            "RTC_STUN_URLS": "stun:rtc.example.com:3478",
            "RTC_TURN_URLS": "turn:rtc.example.com:3478",
            "RTC_TURN_SECRET": "test-secret",
            "RTC_TURN_TTL": "3600",
        }
        with patch.dict(server.os.environ, environment, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host"})
            self.assertEqual(host["iceRefreshSeconds"], 2400)
            status, refreshed = self.request(
                "GET",
                f"/api/rooms/{host['roomCode']}/ice?clientId={host['clientId']}",
                token=host["sessionToken"],
            )
        self.assertEqual(status, 200)
        self.assertEqual(refreshed["iceRefreshSeconds"], 2400)
        self.assertEqual(len(refreshed["iceServers"]), 2)


if __name__ == "__main__":
    unittest.main()
