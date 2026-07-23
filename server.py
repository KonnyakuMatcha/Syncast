#!/usr/bin/env python3
"""Syncast screen-sharing and voice-chat signaling server."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CERT_DIR = ROOT / ".cert"
MAX_BODY_BYTES = 256_000
PARTICIPANT_TTL_SECONDS = 45
ROOM_TTL_SECONDS = 6 * 60 * 60
MAX_PARTICIPANTS = 12
ROOM_ALPHABET = string.ascii_uppercase.replace("I", "").replace("O", "") + "23456789"
DEFAULT_TURN_TTL_SECONDS = 60 * 60


def _urls_from_env(name: str) -> list[str]:
    return [value.strip() for value in os.environ.get(name, "").split(",") if value.strip()]


def turn_ttl_seconds() -> int:
    try:
        return max(300, min(86_400, int(os.environ.get("RTC_TURN_TTL", DEFAULT_TURN_TTL_SECONDS))))
    except ValueError:
        return DEFAULT_TURN_TTL_SECONDS


def build_ice_servers(client_id: str) -> list[dict]:
    """Build browser ICE configuration, including coturn REST credentials."""
    servers: list[dict] = []
    stun_urls = _urls_from_env("RTC_STUN_URLS")
    turn_urls = _urls_from_env("RTC_TURN_URLS")
    if stun_urls:
        servers.append({"urls": stun_urls})
    if not turn_urls:
        return servers

    turn_server: dict = {"urls": turn_urls}
    turn_secret = os.environ.get("RTC_TURN_SECRET", "")
    if turn_secret:
        ttl = turn_ttl_seconds()
        username = f"{int(time.time()) + ttl}:{client_id}"
        digest = hmac.new(turn_secret.encode(), username.encode(), hashlib.sha1).digest()
        turn_server.update({
            "username": username,
            "credential": base64.b64encode(digest).decode(),
        })
    elif os.environ.get("RTC_TURN_USERNAME") and os.environ.get("RTC_TURN_PASSWORD"):
        turn_server.update({
            "username": os.environ["RTC_TURN_USERNAME"],
            "credential": os.environ["RTC_TURN_PASSWORD"],
        })
    servers.append(turn_server)
    return servers


@dataclass
class Participant:
    client_id: str
    name: str
    session_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    joined_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)

    def public(self, host_id: str) -> dict:
        return {
            "id": self.client_id,
            "name": self.name,
            "isHost": self.client_id == host_id,
        }


@dataclass
class Room:
    code: str
    host_id: str
    participants: dict[str, Participant]
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

    def create(self, name: str) -> tuple[Room, Participant]:
        with self.lock:
            while True:
                code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if code not in self.rooms:
                    break
            participant = Participant(self._new_client_id(), name)
            room = Room(code, participant.client_id, {participant.client_id: participant})
            self.rooms[code] = room
            return room, participant

    def join(self, code: str, name: str) -> tuple[Room, Participant]:
        with self.lock:
            self.cleanup()
            room = self.rooms.get(code.upper())
            if not room:
                raise LookupError("房间不存在或已经结束")
            if len(room.participants) >= MAX_PARTICIPANTS:
                raise ValueError("房间人数已满")
            participant = Participant(self._new_client_id(), name)
            room.participants[participant.client_id] = participant
            room.publish("participant-joined", participant.public(room.host_id))
            return room, participant

    def authenticate(self, code: str, client_id: str, session_token: str) -> tuple[Room, Participant]:
        with self.lock:
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
            room.publish("participant-left", {"id": client_id, "name": participant.name})
            if was_host:
                room.publish("room-closed", {})
                self.rooms.pop(room.code, None)

    def cleanup(self) -> None:
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
                room.publish("participant-left", {"id": client_id, "name": participant.name})
        for code in expired_rooms:
            room = self.rooms.pop(code, None)
            if room:
                room.publish("room-closed", {})


STORE = RoomStore()


class LiveHandler(BaseHTTPRequestHandler):
    server_version = "Syncast/1.1"

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

    def room_response(self, room: Room, participant: Participant) -> dict:
        return {
            "roomCode": room.code,
            "clientId": participant.client_id,
            "sessionToken": participant.session_token,
            "hostId": room.host_id,
            "isHost": participant.client_id == room.host_id,
            "sequence": room.next_sequence - 1,
            "iceServers": build_ice_servers(participant.client_id),
            "iceRefreshSeconds": (
                max(60, turn_ttl_seconds() * 2 // 3)
                if os.environ.get("RTC_TURN_SECRET") and _urls_from_env("RTC_TURN_URLS")
                else 0
            ),
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
                "ice": {
                    "stun": bool(_urls_from_env("RTC_STUN_URLS")),
                    "turn": bool(_urls_from_env("RTC_TURN_URLS")),
                },
            })
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/events"):
            self.get_events(parsed)
            return
        if parsed.path.startswith("/api/rooms/") and parsed.path.endswith("/ice"):
            self.get_ice_config(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/rooms":
                room, participant = STORE.create(self.clean_name(payload.get("name")))
                self.send_json(self.room_response(room, participant), HTTPStatus.CREATED)
                return
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "join":
                room, participant = STORE.join(parts[2], self.clean_name(payload.get("name")))
                self.send_json(self.room_response(room, participant))
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
            while time.time() < deadline:
                events = [
                    {key: value for key, value in event.items() if key != "recipient"}
                    for event in room.events
                    if event["sequence"] > since
                    and (event["recipient"] is None or event["recipient"] == client_id)
                ]
                if events:
                    break
                room.condition.wait(timeout=max(0, deadline - time.time()))
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
            "iceServers": build_ice_servers(client_id),
            "iceRefreshSeconds": max(60, turn_ttl_seconds() * 2 // 3),
        })

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
    server = ThreadingHTTPServer((args.host, args.port), LiveHandler)
    scheme = "http"
    if not args.http:
        certificate, key = ensure_certificate(args.host)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"Syncast is running at {scheme}://{args.host}:{args.port}")
    print("Screen and microphone media stay between participants; only signaling reaches this server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
