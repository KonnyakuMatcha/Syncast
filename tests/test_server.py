from __future__ import annotations

import json
import base64
import hashlib
import hmac
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
    broadcast_env = {
        "SYNCAST_BROADCAST_ENABLED": "true",
        "SYNCAST_LIVEKIT_URL": "wss://test.example/Syncast/sfu",
        "SYNCAST_LIVEKIT_API_URL": "http://livekit:7880",
        "LIVEKIT_API_KEY": "testkey",
        "LIVEKIT_API_SECRET": "0123456789abcdef0123456789abcdef",
    }

    def test_broadcast_tokens_require_session_and_limit_publishers(self):
        with patch.dict(server.os.environ, self.broadcast_env, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host"})
            _, guest = self.request("POST", f"/api/rooms/{host['roomCode']}/join", {"name": "Guest"})
            self.assertTrue(host["broadcastAvailable"])
            endpoint = f"/api/rooms/{host['roomCode']}/broadcast-token"
            for user in [host, guest]:
                status, _ = self.request("POST", endpoint, {"clientId": user["clientId"]})
                self.assertEqual(status, 401)
                status, data = self.request("POST", endpoint, {"clientId": user["clientId"]}, user["sessionToken"])
                self.assertEqual(status, 200)
                self.assertEqual(data["url"], self.broadcast_env["SYNCAST_LIVEKIT_URL"])
                header, body, signature = data["token"].split(".")
                expected = hmac.new(self.broadcast_env["LIVEKIT_API_SECRET"].encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
                self.assertEqual(base64.urlsafe_b64decode(signature + "=="), expected)
                claims = json.loads(base64.urlsafe_b64decode(body + "=="))
                self.assertEqual(claims["sub"], user["clientId"])
                self.assertEqual(claims["video"]["room"], f"syncast-{host['roomCode']}-{host['clientId']}")
                self.assertEqual(claims["video"]["canPublish"], user["isHost"])
                self.assertEqual(claims["video"]["canSubscribe"], not user["isHost"])
                self.assertFalse(claims["video"]["canPublishData"])
                self.assertNotIn("roomAdmin", claims["video"])
                self.assertLessEqual(claims["exp"] - int(time.time()), 60)
                self.assertNotIn(self.broadcast_env["LIVEKIT_API_SECRET"], json.dumps(data))
                if user["isHost"]:
                    self.assertEqual(claims["video"]["canPublishSources"], ["screen_share", "screen_share_audio"])
            status, _ = self.request("POST", endpoint, {"clientId": host["clientId"]}, guest["sessionToken"])
            self.assertEqual(status, 401)

    def test_broadcast_disabled_by_default_and_invalid_config_rejected(self):
        for env in [{}, {**self.broadcast_env, "LIVEKIT_API_SECRET": "short"}]:
            with patch.dict(server.os.environ, env, clear=True):
                _, host = self.request("POST", "/api/rooms", {"name": "Host"})
                self.assertFalse(host["broadcastAvailable"])
                status, _ = self.request("POST", f"/api/rooms/{host['roomCode']}/broadcast-token",
                                         {"clientId": host["clientId"]}, host["sessionToken"])
                self.assertEqual(status, 400)

    def test_departed_members_cannot_get_new_broadcast_tokens(self):
        with patch.dict(server.os.environ, self.broadcast_env, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host"})
            _, guest = self.request("POST", f"/api/rooms/{host['roomCode']}/join", {"name": "Guest"})
            self.request("DELETE", f"/api/rooms/{host['roomCode']}?clientId={guest['clientId']}", token=guest["sessionToken"])
            status, _ = self.request("POST", f"/api/rooms/{host['roomCode']}/broadcast-token",
                                     {"clientId": guest["clientId"]}, guest["sessionToken"])
            self.assertEqual(status, 401)

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

    def test_ice_configuration_is_stun_only(self) -> None:
        environment = {
            "RTC_STUN_URLS": "stun:rtc.example.com:3478",
            "RTC_TURN_URLS": "turn:rtc.example.com:3478?transport=udp,turn:rtc.example.com:3478?transport=tcp",
            "RTC_TURN_SECRET": "test-secret",
        }
        with patch.dict(server.os.environ, environment, clear=True):
            ice_servers = server.build_ice_servers()
        self.assertEqual(ice_servers, [{"urls": ["stun:rtc.example.com:3478"]}])

    def test_authenticated_ice_config_stays_stun_only(self) -> None:
        environment = {
            "RTC_STUN_URLS": "stun:rtc.example.com:3478",
            "RTC_TURN_URLS": "turn:rtc.example.com:3478",
            "RTC_TURN_SECRET": "test-secret",
        }
        with patch.dict(server.os.environ, environment, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host"})
            self.assertEqual(host["iceRefreshSeconds"], 0)
            status, refreshed = self.request(
                "GET",
                f"/api/rooms/{host['roomCode']}/ice?clientId={host['clientId']}",
                token=host["sessionToken"],
            )
        self.assertEqual(status, 200)
        self.assertEqual(refreshed["iceRefreshSeconds"], 0)
        self.assertEqual(refreshed["iceServers"], [{"urls": ["stun:rtc.example.com:3478"]}])


if __name__ == "__main__":
    unittest.main()
