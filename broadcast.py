"""Optional LiveKit SFU integration; credentials never leave the server."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import queue
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

TOKEN_TTL = 60


def configuration() -> dict | None:
    if os.environ.get("SYNCAST_BROADCAST_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return None
    config = {
        "url": os.environ.get("SYNCAST_LIVEKIT_URL", "").rstrip("/"),
        "api_url": os.environ.get("SYNCAST_LIVEKIT_API_URL", "").rstrip("/"),
        "key": os.environ.get("LIVEKIT_API_KEY", ""),
        "secret": os.environ.get("LIVEKIT_API_SECRET", ""),
    }
    public = urlparse(config["url"])
    internal = urlparse(config["api_url"])
    if (public.scheme not in {"ws", "wss"} or not public.hostname
            or internal.scheme not in {"http", "https"} or not internal.hostname
            or not config["key"] or len(config["secret"]) < 32):
        raise ValueError("服务器广播配置不完整：请设置 LiveKit 地址、API 地址和密钥（secret 至少 32 字符）")
    return config


def available() -> bool:
    try:
        return configuration() is not None
    except ValueError:
        return False


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def sign_token(config: dict, claims: dict) -> str:
    now = int(time.time())
    payload = {"iss": config["key"], "nbf": now - 5, "exp": now + TOKEN_TTL, **claims}
    header = _encode(b'{"alg":"HS256","typ":"JWT"}')
    body = _encode(json.dumps(payload, separators=(",", ":")).encode())
    message = f"{header}.{body}"
    signature = hmac.new(config["secret"].encode(), message.encode(), hashlib.sha256).digest()
    return f"{message}.{_encode(signature)}"


def room_name(room) -> str:
    # A reused six-character room code must never grant access to an old room.
    return f"syncast-{room.code}-{room.host_id}"


def join_credentials(room, participant) -> dict:
    config = configuration()
    if config is None:
        raise ValueError("此服务器尚未启用服务器广播")
    is_host = participant.client_id == room.host_id
    token = sign_token(config, {
        "sub": participant.client_id,
        "name": participant.name,
        "video": {
            "roomJoin": True,
            "room": room_name(room),
            "canPublish": is_host,
            "canPublishSources": ["screen_share", "screen_share_audio"] if is_host else [],
            "canSubscribe": not is_host,
            "canPublishData": False,
            "canUpdateOwnMetadata": False,
        },
    })
    return {"url": config["url"], "token": token}


def _remove(config: dict, name: str, identity: str | None) -> None:
    method = "RemoveParticipant" if identity else "DeleteRoom"
    payload = {"room": name}
    if identity:
        payload["identity"] = identity
    grant = {"roomAdmin": True, "room": name} if identity else {"roomCreate": True}
    token = sign_token(config, {"video": grant})
    request = Request(
        f'{config["api_url"]}/twirp/livekit.RoomService/{method}',
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            response.read()
    except HTTPError as error:
        if error.code != 404:
            raise


_cleanup_queue = queue.Queue()
_worker_lock = threading.Lock()
_worker_started = False


def _cleanup_worker() -> None:
    while True:
        config, name, identity = _cleanup_queue.get()
        try:
            for attempt in range(3):
                try:
                    _remove(config, name, identity)
                    break
                except Exception:
                    if attempt == 2:
                        logging.warning("LiveKit cleanup failed for %s (%s)", name, identity or "room")
                    else:
                        time.sleep(attempt + 1)
        finally:
            _cleanup_queue.task_done()


def schedule_cleanup(room, identity: str | None = None) -> None:
    """Do network I/O outside the room-store lock, including expiry cleanup."""
    global _worker_started
    if not room.broadcast_used:
        return
    config = configuration()
    if config is None:
        return
    with _worker_lock:
        if not _worker_started:
            threading.Thread(target=_cleanup_worker, daemon=True, name="livekit-cleanup").start()
            _worker_started = True
    _cleanup_queue.put((config, room_name(room), identity))
