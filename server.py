#!/usr/bin/env python3
"""Syncast screen-sharing and voice-chat signaling server."""

from __future__ import annotations

import argparse
import ipaddress
import json
import mimetypes
import os
import secrets
import ssl
import string
import subprocess
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as BaseThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import broadcast
import reliable


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CERT_DIR = ROOT / ".cert"
MAX_BODY_BYTES = 256_000
PARTICIPANT_TTL_SECONDS = 45
ROOM_TTL_SECONDS = 6 * 60 * 60
MAX_PARTICIPANTS = 12
ROOM_ALPHABET = string.ascii_uppercase.replace("I", "").replace("O", "") + "23456789"
def _urls_from_env(name: str) -> list[str]:
    return [value.strip() for value in os.environ.get(name, "").split(",") if value.strip()]


def build_ice_servers() -> list[dict]:
    """Build a STUN-only ICE configuration so media can never use TURN."""
    stun_urls = _urls_from_env("RTC_STUN_URLS")
    return [{"urls": stun_urls}] if stun_urls else []


@dataclass
class Participant:
    client_id: str
    name: str
    relay_capable: bool = True
    session_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    joined_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    initial_sequence: int = 0

    def public(self, host_id: str) -> dict:
        return {
            "id": self.client_id,
            "name": self.name,
            "isHost": self.client_id == host_id,
            "relayCapable": self.relay_capable,
        }


@dataclass
class Room:
    code: str
    host_id: str
    participants: dict[str, Participant]
    broadcast_used: bool = False
    media_transport: str = "p2p"
    transport_version: int = 0
    topology_mode: str = "auto"
    stage_version: int = 0
    stage_topology: dict | None = None
    relay: reliable.Relay = field(default_factory=reliable.Relay)
    created_at: float = field(default_factory=time.time)
    next_sequence: int = 1
    events: list[dict] = field(default_factory=list)
    condition: threading.Condition = field(default_factory=threading.Condition)

    def publish(self, event_type: str, payload: dict, recipient: str | None = None) -> None:
        with self.condition:
            event = {
                "sequence": self.next_sequence,
                "type": event_type,
                "payload": payload,
                "recipient": recipient,
            }
            self.next_sequence += 1
            self.events.append(event)
            if len(self.events) > 2_000:
                self.events = self.events[-1_000:]
            self.condition.notify_all()


class RoomStore:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.lock = threading.RLock()

    @staticmethod
    def _new_client_id() -> str:
        return secrets.token_urlsafe(24)

    def create(self, name: str, relay_capable: bool = True, media_transport: str = "p2p") -> tuple[Room, Participant]:
        with self.lock:
            self.cleanup()
            while True:
                code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if code not in self.rooms:
                    break
            participant = Participant(self._new_client_id(), name, relay_capable)
            room = Room(code, participant.client_id, {participant.client_id: participant})
            room.media_transport = media_transport
            room.topology_mode = "server" if media_transport == "server" else "auto"
            self.rooms[code] = room
            return room, participant

    def join(self, code: str, name: str, relay_capable: bool = True) -> tuple[Room, Participant]:
        with self.lock:
            self.cleanup()
            room = self.rooms.get(code.upper())
            if not room:
                raise LookupError("房间不存在或已经结束")
            if len(room.participants) >= MAX_PARTICIPANTS:
                raise ValueError("房间人数已满")
            participant = Participant(self._new_client_id(), name, relay_capable)
            participant.initial_sequence = room.next_sequence - 1
            room.participants[participant.client_id] = participant
            room.publish("participant-joined", participant.public(room.host_id))
            return room, participant

    def authenticate(self, code: str, client_id: str, session_token: str) -> tuple[Room, Participant]:
        with self.lock:
            self.cleanup()
            room = self.rooms.get(code.upper())
            participant = room.participants.get(client_id) if room else None
            if (
                not room
                or not participant
                or not session_token
                or not secrets.compare_digest(participant.session_token, session_token)
            ):
                raise PermissionError("会话已失效，请重新加入房间")
            participant.last_seen = time.time()
            return room, participant

    def leave(self, code: str, client_id: str, session_token: str) -> None:
        with self.lock:
            room, _ = self.authenticate(code, client_id, session_token)
            was_host = client_id == room.host_id
            participant = room.participants.pop(client_id)
            broadcast.schedule_cleanup(room, None if was_host else client_id)
            room.publish("participant-left", {"id": client_id, "name": participant.name})
            if was_host:
                room.relay.close()
                room.publish("room-closed", {})
                self.rooms.pop(room.code, None)

    def cleanup(self) -> None:
        with self.lock:
            self._cleanup_locked()

    def _cleanup_locked(self) -> None:
        now = time.time()
        expired_rooms: list[str] = []
        for code, room in list(self.rooms.items()):
            if now - room.created_at > ROOM_TTL_SECONDS:
                expired_rooms.append(code)
                continue
            stale = [
                client_id
                for client_id, participant in room.participants.items()
                if now - participant.last_seen > PARTICIPANT_TTL_SECONDS
            ]
            if room.host_id in stale:
                expired_rooms.append(code)
                continue
            for client_id in stale:
                participant = room.participants.pop(client_id)
                broadcast.schedule_cleanup(room, client_id)
                room.publish("participant-left", {"id": client_id, "name": participant.name})
        for code in expired_rooms:
            room = self.rooms.pop(code, None)
            if room:
                room.relay.close()
                broadcast.schedule_cleanup(room)
                room.publish("room-closed", {})


STORE = RoomStore()


class ThreadingHTTPServer(BaseThreadingHTTPServer):
    # Six browsers can load scripts, negotiate media and long-poll together.
    # The stdlib's five pending connections are too few for these bursts.
    request_queue_size = 128


class LiveHandler(BaseHTTPRequestHandler):
    server_version = "Syncast/1.1"

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
            # A tab may leave or abort its long poll before the reply arrives.
            self.close_connection = True

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: dict | list, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求内容为空或过大")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("请求格式无效")
        return value

    @staticmethod
    def clean_name(value: object) -> str:
        name = str(value or "").strip()
        if not name:
            raise ValueError("请输入昵称")
        return name[:24]

    @staticmethod
    def relay_capable(value: object) -> bool:
        return value is not False

    def room_response(self, room: Room, participant: Participant) -> dict:
        with STORE.lock:
            return {
                "roomCode": room.code,
                "clientId": participant.client_id,
                "sessionToken": participant.session_token,
                "hostId": room.host_id,
                "isHost": participant.client_id == room.host_id,
                "sequence": participant.initial_sequence,
                "iceServers": build_ice_servers(),
                "iceRefreshSeconds": 0,
                "broadcastAvailable": broadcast.available(),
                "mediaTransport": room.media_transport,
                "transportVersion": room.transport_version,
                "topologyMode": room.topology_mode,
                "participants": [item.public(room.host_id) for item in room.participants.values()],
            }

    def bearer_token(self) -> str:
        authorization = self.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        return token if scheme.lower() == "bearer" else ""

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({
                "ok": True,
                "broadcast": {"configured": broadcast.available()},
                "ice": {
                    "stun": bool(_urls_from_env("RTC_STUN_URLS")),
                    "turn": False,
                },
            })
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/events"):
            self.get_events(parsed)
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/ice"):
            self.get_ice_config(parsed)
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/state"):
            query = parse_qs(parsed.query)
            try:
                with STORE.lock:
                    room, _ = STORE.authenticate(parsed.path.split("/")[3], query.get("clientId", [""])[0], self.bearer_token())
                    snapshot = {"mediaTransport": room.media_transport, "transportVersion": room.transport_version,
                                "topologyMode": room.topology_mode, "stageTopology": room.stage_topology}
                self.send_json(snapshot)
            except PermissionError as error:
                self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/relay"):
            self.get_reliable_media(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "relay":
                query = parse_qs(parsed.query)
                room, participant = STORE.authenticate(parts[2], query.get("clientId", [""])[0], self.bearer_token())
                if participant.client_id != room.host_id:
                    raise PermissionError("只有房主可以发布广播")
                if room.media_transport != "server" or not room.stage_topology or not room.stage_topology["source"].get("reliable"):
                    raise ValueError("可靠广播尚未开始")
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > reliable.MAX_SEGMENT:
                    raise ValueError("广播数据无效或过大")
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("广播数据不完整")
                room.relay.append(self.headers.get("X-Broadcast-Generation", ""), int(self.headers.get("X-Broadcast-Sequence", "-1")),
                                  self.headers.get("Content-Type", ""), body)
                self.send_json({"ok": True})
                return
            payload = self.read_json()
            if parsed.path == "/api/rooms":
                transport = "server" if payload.get("mediaTransport") == "server" and broadcast.available() else "p2p"
                room, participant = STORE.create(
                    self.clean_name(payload.get("name")),
                    self.relay_capable(payload.get("relayCapable")),
                    transport,
                )
                if transport == "p2p" and payload.get("topologyMode") in ("auto", "direct", "relay"):
                    room.topology_mode = payload["topologyMode"]
                self.send_json(self.room_response(room, participant), HTTPStatus.CREATED)
                return
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "join":
                room, participant = STORE.join(
                    parts[2],
                    self.clean_name(payload.get("name")),
                    self.relay_capable(payload.get("relayCapable")),
                )
                self.send_json(self.room_response(room, participant))
                return
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "transport":
                with STORE.lock:
                    room, participant = STORE.authenticate(
                        parts[2], str(payload.get("clientId", "")), self.bearer_token()
                    )
                    if participant.client_id != room.host_id:
                        raise PermissionError("只有房主可以切换连接模式")
                    transport = payload.get("mediaTransport")
                    if transport not in ("p2p", "server"):
                        raise ValueError("连接模式无效")
                    if transport == "server" and not broadcast.available():
                        raise ValueError("此服务器尚未启用服务器广播")
                    mode = payload.get("topologyMode", "server" if transport == "server" else "direct")
                    if mode not in ("auto", "direct", "relay", "server") or (mode == "server") != (transport == "server"):
                        raise ValueError("连接方式无效")
                    if room.media_transport != transport or room.topology_mode != mode:
                        room.media_transport = transport
                        room.topology_mode = mode
                        room.transport_version += 1
                        room.publish("media-transport", {
                            "mediaTransport": transport, "transportVersion": room.transport_version,
                            "topologyMode": mode,
                        })
                    response = {"mediaTransport": room.media_transport, "transportVersion": room.transport_version,
                                "topologyMode": room.topology_mode}
                self.send_json(response)
                return
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "stage":
                with STORE.lock:
                    room, participant = STORE.authenticate(parts[2], str(payload.get("clientId", "")), self.bearer_token())
                    if participant.client_id != room.host_id:
                        raise PermissionError("只有房主可以更新直播状态")
                    if payload.get("transportVersion") != room.transport_version:
                        raise ValueError("连接模式已改变，请重新同步")
                    source, nodes = payload.get("source"), payload.get("nodes")
                    if not isinstance(source, dict) or not isinstance(nodes, dict):
                        raise ValueError("直播状态无效")
                    room.stage_version += 1
                    response = {"version": room.stage_version, "transport": room.media_transport,
                                "transportVersion": room.transport_version, "enabled": payload.get("enabled") is True,
                                "source": {key: source.get(key) is True for key in ("live", "hasAudio", "audioEnabled")},
                                "nodes": nodes}
                    response["source"]["reliable"] = source.get("reliable") is True
                    if not response["source"]["live"] or not response["source"]["reliable"]:
                        room.relay.close()
                    room.stage_topology = response
                    room.publish("stage-topology", response)
                self.send_json(response)
                return
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "signal":
                room, participant = STORE.authenticate(
                    parts[2], str(payload.get("clientId", "")), self.bearer_token()
                )
                recipient = str(payload.get("to", ""))
                if recipient not in room.participants:
                    raise LookupError("接收者已离开房间")
                room.publish(
                    "signal",
                    {"from": participant.client_id, "data": payload.get("data")},
                    recipient,
                )
                self.send_json({"ok": True})
                return
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "broadcast-token":
                with STORE.lock:
                    room, participant = STORE.authenticate(
                        parts[2], str(payload.get("clientId", "")), self.bearer_token()
                    )
                    credentials = broadcast.join_credentials(room, participant)
                    room.broadcast_used = True
                self.send_json(credentials)
                return
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "heartbeat":
                STORE.authenticate(
                    parts[2], str(payload.get("clientId", "")), self.bearer_token()
                )
                self.send_json({"ok": True})
                return
            self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
        except LookupError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) != 3 or parts[:2] != ["api", "rooms"]:
            self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
            return
        query = parse_qs(parsed.query)
        try:
            STORE.leave(parts[2], query.get("clientId", [""])[0], self.bearer_token())
            self.send_json({"ok": True})
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)

    def get_events(self, parsed) -> None:
        parts = parsed.path.strip("/").split("/")
        query = parse_qs(parsed.query)
        client_id = query.get("clientId", [""])[0]
        try:
            since = max(0, int(query.get("since", ["0"])[0]))
            room, _ = STORE.authenticate(parts[2], client_id, self.bearer_token())
        except (ValueError, PermissionError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
            return

        deadline = time.time() + 20
        events: list[dict] = []
        cursor = since
        with room.condition:
            while True:
                events = [
                    {key: value for key, value in event.items() if key != "recipient"}
                    for event in room.events
                    if event["sequence"] > since
                    and (event["recipient"] is None or event["recipient"] == client_id)
                ]
                remaining = deadline - time.time()
                if events or remaining <= 0:
                    break
                room.condition.wait(timeout=remaining)
            # Capture the cursor while holding the same lock used by publish().
            # Every event at or below this value was included in the filter above.
            cursor = room.next_sequence - 1
        self.send_json({"events": events, "sequence": cursor})

    def get_ice_config(self, parsed) -> None:
        parts = parsed.path.strip("/").split("/")
        query = parse_qs(parsed.query)
        client_id = query.get("clientId", [""])[0]
        try:
            STORE.authenticate(parts[2], client_id, self.bearer_token())
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
            return
        self.send_json({
            "iceServers": build_ice_servers(),
            "iceRefreshSeconds": 0,
        })

    def get_reliable_media(self, parsed):
        query = parse_qs(parsed.query)
        client_id = query.get("clientId", [""])[0]
        try:
            room, _ = STORE.authenticate(parsed.path.split("/")[3], client_id, self.bearer_token())
            generation = query.get("generation", [""])[0][:80]
            cursor = max(0, int(query.get("cursor", ["0"])[0]))
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
            return
        deadline = time.monotonic() + 2
        chunk = None
        with room.relay.condition:
            while room.relay.active:
                chunk = room.relay.read(generation, cursor)
                if chunk and (chunk[0]["reset"] or len(chunk[1]) >= 512 * 1024 or time.monotonic() >= deadline):
                    break
                if time.monotonic() >= deadline:
                    break
                room.relay.condition.wait(timeout=max(0, deadline - time.monotonic()))
        body = reliable.frame(*chunk) if chunk else reliable.frame({"generation": generation, "cursor": cursor, "reset": False})
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = target.read_bytes()
        content_type, _ = mimetypes.guess_type(target.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)


def ensure_certificate(host: str) -> tuple[Path, Path]:
    certificate = CERT_DIR / "cert.pem"
    key = CERT_DIR / "key.pem"
    metadata = CERT_DIR / "hosts.txt"
    addresses = {"127.0.0.1"}
    if host != "0.0.0.0":
        addresses.add(host)
    try:
        result = subprocess.run(["hostname", "-I"], check=True, capture_output=True, text=True)
        for candidate in result.stdout.split():
            try:
                address = ipaddress.ip_address(candidate)
                if address.version == 4:
                    addresses.add(str(address))
            except ValueError:
                continue
    except (OSError, subprocess.CalledProcessError):
        pass
    san = "DNS:localhost," + ",".join(f"IP:{address}" for address in sorted(addresses))
    if certificate.exists() and key.exists() and metadata.exists() and metadata.read_text() == san:
        return certificate, key
    CERT_DIR.mkdir(exist_ok=True)
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(certificate), "-days", "3650",
            "-subj", "/CN=Syncast",
            "-addext", f"subjectAltName={san}",
        ],
        check=True,
        capture_output=True,
    )
    metadata.write_text(san)
    return certificate, key


def main() -> None:
    parser = argparse.ArgumentParser(description="Syncast signaling server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8443, type=int)
    parser.add_argument("--http", action="store_true", help="Disable TLS (localhost testing only)")
    args = parser.parse_args()
    broadcast.configuration()  # Fail early on an explicitly enabled but invalid configuration.
    server = ThreadingHTTPServer((args.host, args.port), LiveHandler)
    scheme = "http"
    if not args.http:
        certificate, key = ensure_certificate(args.host)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"Syncast is running at {scheme}://{args.host}:{args.port}")
    print("Optional server broadcasting is " + ("enabled (LiveKit)." if broadcast.available() else "disabled; media uses P2P."))
    stopping = threading.Event()

    def cleanup_rooms():
        while not stopping.wait(10):
            STORE.cleanup()

    threading.Thread(target=cleanup_rooms, daemon=True, name="room-cleanup").start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        stopping.set()
        server.server_close()


if __name__ == "__main__":
    main()
