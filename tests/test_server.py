from __future__ import annotations

import json
import base64
import hashlib
import hmac
import struct
import sys
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse


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

    def test_join_cursor_does_not_skip_signals_published_before_response(self):
        cursor = self.guest.initial_sequence
        self.room.publish("signal", {"from": self.host.client_id, "data": {"channel": "voice"}}, self.guest.client_id)
        with patch.object(server, "STORE", self.store):
            handler = object.__new__(server.LiveHandler)
            response = handler.room_response(self.room, self.guest)
        self.assertEqual(response["sequence"], cursor)
        self.assertGreater(self.room.events[-1]["sequence"], response["sequence"])

    def test_poll_rescans_events_after_wait_expires(self):
        handler = object.__new__(server.LiveHandler)
        handler.bearer_token = lambda: self.guest.session_token
        replies = []
        handler.send_json = lambda payload: replies.append(payload)
        since = self.room.next_sequence - 1
        clock = [time.time()]

        def expire(timeout):
            clock[0] += timeout + 0.01
            self.room.publish("signal", {"from": self.host.client_id, "data": {"channel": "stage-stop"}}, self.guest.client_id)

        with patch.object(server, "STORE", self.store), patch.object(server.time, "time", lambda: clock[0]), \
                patch.object(self.room.condition, "wait", expire):
            handler.get_events(urlparse(f"/api/rooms/{self.room.code}/events?clientId={self.guest.client_id}&since={since}"))
        self.assertEqual(len(replies[0]["events"]), 1)
        self.assertEqual(replies[0]["events"][0]["sequence"], replies[0]["sequence"])


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
                self.assertTrue(claims["video"]["canPublish"])
                self.assertTrue(claims["video"]["canSubscribe"])
                self.assertFalse(claims["video"]["canPublishData"])
                self.assertNotIn("roomAdmin", claims["video"])
                self.assertLessEqual(claims["exp"] - int(time.time()), 60)
                self.assertNotIn(self.broadcast_env["LIVEKIT_API_SECRET"], json.dumps(data))
                if user["isHost"]:
                    self.assertEqual(claims["video"]["canPublishSources"], ["microphone", "screen_share", "screen_share_audio"])
                else:
                    self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])
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

    def test_only_host_can_change_transport_and_joiners_get_current_mode(self):
        with patch.dict(server.os.environ, self.broadcast_env, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host", "mediaTransport": "server"})
            code = host["roomCode"]
            self.assertEqual(host["mediaTransport"], "server")
            _, guest = self.request("POST", f"/api/rooms/{code}/join", {"name": "Guest"})
            self.assertEqual(guest["mediaTransport"], "server")
            endpoint = f"/api/rooms/{code}/transport"
            for token in ["", guest["sessionToken"]]:
                status, _ = self.request("POST", endpoint, {"clientId": guest["clientId"], "mediaTransport": "p2p"}, token)
                self.assertEqual(status, 401)
            status, data = self.request("POST", endpoint, {"clientId": host["clientId"], "mediaTransport": "p2p"}, host["sessionToken"])
            self.assertEqual(status, 200)
            self.assertEqual(data, {"mediaTransport": "p2p", "transportVersion": 1, "topologyMode": "direct"})
            _, events = self.request("GET", f"/api/rooms/{code}/events?clientId={guest['clientId']}&since={guest['sequence']}", token=guest["sessionToken"])
            self.assertEqual(events["events"][-1]["type"], "media-transport")
            self.assertEqual(events["events"][-1]["payload"], data)
            _, late = self.request("POST", f"/api/rooms/{code}/join", {"name": "Late"})
            self.assertEqual(late["mediaTransport"], "p2p")
            self.assertEqual(late["transportVersion"], 1)
            status, _ = self.request("POST", endpoint, {"clientId": host["clientId"], "mediaTransport": "bad"}, host["sessionToken"])
            self.assertEqual(status, 400)

    def test_server_transport_cannot_be_enabled_without_configuration(self):
        with patch.dict(server.os.environ, {}, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host", "mediaTransport": "server"})
            self.assertEqual(host["mediaTransport"], "p2p")
            status, _ = self.request("POST", f"/api/rooms/{host['roomCode']}/transport",
                                     {"clientId": host["clientId"], "mediaTransport": "server"}, host["sessionToken"])
            self.assertEqual(status, 400)

    def test_stage_snapshot_is_authorized_versioned_and_recoverable(self):
        _, host = self.request("POST", "/api/rooms", {"name": "Host"})
        code = host["roomCode"]
        _, guest = self.request("POST", f"/api/rooms/{code}/join", {"name": "Guest"})
        payload = {"clientId": guest["clientId"], "transportVersion": 0,
                   "source": {"live": True, "hasAudio": True, "audioEnabled": True}, "nodes": {}}
        status, _ = self.request("POST", f"/api/rooms/{code}/stage", payload, guest["sessionToken"])
        self.assertEqual(status, 401)
        payload["clientId"] = host["clientId"]
        status, topology = self.request("POST", f"/api/rooms/{code}/stage", payload, host["sessionToken"])
        self.assertEqual(status, 200)
        self.assertEqual(topology["version"], 1)
        path = f"/api/rooms/{code}/state?clientId={guest['clientId']}"
        self.assertEqual(self.request("GET", path)[0], 401)
        status, snapshot = self.request("GET", path, token=guest["sessionToken"])
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["stageTopology"], topology)
        payload["transportVersion"] = 123
        self.assertEqual(self.request("POST", f"/api/rooms/{code}/stage", payload, host["sessionToken"])[0], 400)

    def test_reliable_media_requires_session_and_only_host_can_upload(self):
        import reliable
        with patch.dict(server.os.environ, self.broadcast_env, clear=True):
            _, host = self.request("POST", "/api/rooms", {"name": "Host", "mediaTransport": "server"})
            code = host["roomCode"]
            _, guest = self.request("POST", f"/api/rooms/{code}/join", {"name": "Guest"})
            self.request("POST", f"/api/rooms/{code}/stage", {"clientId": host["clientId"], "transportVersion": 0,
                "source": {"live": True, "reliable": True}, "nodes": {}}, host["sessionToken"])
            body = b"init" + reliable.CLUSTER + b"\xe7\x81\x00\xa3\x85\x81\x00\x00\x80x"
            for user, expected in [(guest, 401), (host, 200), (host, 200)]:
                connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
                connection.request("POST", f"/api/rooms/{code}/relay?clientId={user['clientId']}", body=body,
                    headers={"Authorization": f"Bearer {user['sessionToken']}", "Content-Type": "video/webm;codecs=vp8,opus",
                             "X-Broadcast-Generation": "test-generation", "X-Broadcast-Sequence": "0"})
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                response.read(); connection.close()
            path = f"/api/rooms/{code}/relay?clientId={guest['clientId']}"
            self.assertEqual(self.request("GET", path)[0], 401)
            connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
            connection.request("GET", path, headers={"Authorization": f"Bearer {guest['sessionToken']}"})
            response = connection.getresponse()
            self.assertEqual(response.getheader("X-Accel-Buffering"), "no")
            length = struct.unpack("!I", response.read(4))[0]
            metadata = json.loads(response.read(length))
            self.assertTrue(metadata["reset"])
            self.assertEqual(response.read(metadata["bytes"]), body)
            connection.close()
            self.request("DELETE", f"/api/rooms/{code}?clientId={host['clientId']}", token=host["sessionToken"])

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
        self.assertIn('<option value="720">720p</option>', body)
        self.assertIn('<option value="1080" selected>1080p</option>', body)
        self.assertIn('<option value="30">30 fps</option>', body)
        self.assertIn('<option value="60" selected>60 fps</option>', body)
        self.assertIn('id="topology-mode"', body)
        self.assertIn('src="topology.js"', body)

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
        signals = [event for event in events["events"] if event["type"] == "signal"]
        self.assertEqual(signals[0]["payload"]["from"], host["clientId"])

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
