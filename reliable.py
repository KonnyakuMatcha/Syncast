"""Bounded, authenticated media fan-out; the application never decodes video."""

from __future__ import annotations

import json
import struct
import threading
import time
import re
import mp4

MAX_SEGMENT = 4 * 1024 * 1024
MAX_CACHE = 16 * 1024 * 1024
CLUSTER = b"\x1f\x43\xb6\x75\x01\xff\xff\xff\xff\xff\xff\xff"
MIMES = {"video/webm;codecs=vp8,opus", "video/webm;codecs=vp8",
         "video/mp4;codecs=avc1.4d0028,mp4a.40.2", "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
         "video/mp4;codecs=avc1.4d0028", "video/mp4;codecs=avc1.4d002a"}


def supported_mime(mime):
    return mime in MIMES or re.fullmatch(r"video/mp4;codecs=avc1\.[0-9a-f]{6}(?:,mp4a\.40\.2)?", mime) is not None


def _vint(data, offset, identifier=False):
    if offset >= len(data) or data[offset] == 0:
        return None
    length = 1
    mask = 0x80
    while not data[offset] & mask:
        length += 1
        mask >>= 1
    if length > 8 or offset + length > len(data):
        return None
    value = int.from_bytes(data[offset:offset + length], "big")
    return (value if identifier else value & ((1 << (7 * length)) - 1), length)


def _children(data, start, end):
    while start < end:
        element = _vint(data, start, True)
        if element is None:
            return
        size = _vint(data, start + element[1])
        if size is None:
            return
        payload = start + element[1] + size[1]
        stop = payload + size[0]
        if stop > len(data) or stop > end:
            return
        yield element[0], payload, stop
        start = stop


def _video_track(initialization):
    position = initialization.find(b"\x16\x54\xae\x6b")  # Tracks, in uncompressed initialization only.
    if position < 0:
        return 1
    size = _vint(initialization, position + 4)
    if size is None:
        return 1
    start = position + 4 + size[1]
    for identifier, payload, end in _children(initialization, start, start + size[0]):
        if identifier != 0xAE:
            continue
        fields = {key: int.from_bytes(initialization[a:b], "big")
                  for key, a, b in _children(initialization, payload, end) if key in (0xD7, 0x83)}
        if fields.get(0x83) == 1:
            return fields.get(0xD7, 1)
    return 1


def _starts_with_keyframe(data, offset, video_track=1):
    """Read EBML children, never scan compressed payload for a keyframe flag."""
    offset += len(CLUSTER)
    for _ in range(64):
        element = _vint(data, offset, True)
        if element is None:
            return None
        size = _vint(data, offset + element[1])
        if size is None:
            return None
        payload = offset + element[1] + size[1]
        if element[0] == 0xA3:  # SimpleBlock, track 1 is the published video.
            track = _vint(data, payload)
            if track is None or payload + track[1] + 3 > len(data):
                return None
            if track[0] == video_track:
                return bool(data[payload + track[1] + 2] & 0x80)
        elif element[0] == 0x1F43B675:
            return False  # Completed audio-only cluster; do not rescan it forever.
        elif element[0] == 0xA0:  # BlockGroup: absence of ReferenceBlock means an intra frame.
            end = payload + size[0]
            if end > len(data):
                return None
            video, reference = False, False
            for key, a, b in _children(data, payload, end):
                if key == 0xA1:
                    track = _vint(data, a)
                    video = track is not None and track[0] == video_track
                elif key == 0xFB:
                    reference = True
            if video:
                return not reference
        offset = payload + size[0]
        if offset >= len(data):
            return None
    return False


def frame(metadata: dict, body: bytes = b"") -> bytes:
    header = json.dumps({**metadata, "bytes": len(body)}, separators=(",", ":")).encode()
    return struct.pack("!I", len(header)) + header + body


class Relay:
    def __init__(self):
        self.condition = threading.Condition()
        self.generation = ""
        self.sequence = -1
        self.mime = ""
        self.initialization = b""
        self.data = bytearray()
        self.base = 0
        self.clusters: dict[int, bool | None] = {}
        self.updated = 0.0
        self.active = True
        self.video_track = 1
        self.pending = {}
        self.retired = []
        self.parse_position = 0

    def append(self, generation, sequence, mime, body):
        if not body or len(body) > MAX_SEGMENT or not generation or len(generation) > 80:
            raise ValueError("广播数据无效或过大")
        if not supported_mime(mime):
            raise ValueError("广播编码不受支持")
        with self.condition:
            if generation != self.generation:
                if generation in self.retired or not 0 <= sequence < 8:
                    raise ValueError("广播片段已过期，请重新开始共享")
                if self.generation:
                    self.retired = (self.retired + [self.generation])[-16:]
                self.generation = generation
                self.sequence = -1
                self.mime = mime
                self.initialization = b""
                self.data.clear()
                self.clusters.clear()
                self.base = 0
                self.pending = {}
                self.parse_position = 0
            if sequence <= self.sequence:
                return  # A repeated upload after a lost ACK must be harmless.
            if sequence > self.sequence + 32 or sum(len(x) for x in self.pending.values()) + len(body) > MAX_CACHE:
                raise ValueError("广播上传窗口已满，请重新开始共享")
            self.pending.setdefault(sequence, body)
            chunks = []
            while self.sequence + 1 in self.pending:
                self.sequence += 1
                chunks.append(self.pending.pop(self.sequence))
            if not chunks:
                return
            body = b"".join(chunks)
            scan_from = max(0, len(self.data) - len(CLUSTER) + 1)
            self.data.extend(body)
            if mime.startswith("video/mp4"):
                for kind, position, payload, end in mp4.boxes(self.data, self.parse_position - self.base):
                    if kind == b"moof":
                        if not self.initialization:
                            if position > 64 * 1024:
                                raise ValueError("广播初始化数据过大")
                            self.initialization = bytes(self.data[:position])
                            self.video_track = mp4.video_track(self.initialization)
                        self.clusters[self.base + position] = mp4.keyframe(self.data, payload, end, self.video_track)
                    self.parse_position = self.base + end
            else:
                position = self.data.find(CLUSTER, scan_from)
                while position >= 0:
                    absolute = self.base + position
                    if not self.initialization and self.base == 0:
                        if position > 64 * 1024:
                            raise ValueError("广播初始化数据过大")
                        self.initialization = bytes(self.data[:position])
                        self.video_track = _video_track(self.initialization)
                    self.clusters.setdefault(absolute, None)
                    position = self.data.find(CLUSTER, position + len(CLUSTER))
                for absolute, keyframe in list(self.clusters.items()):
                    if keyframe is None:
                        self.clusters[absolute] = _starts_with_keyframe(self.data, absolute - self.base, self.video_track)
            excess = len(self.data) - MAX_CACHE
            if excess > 0:
                del self.data[:excess]
                self.base += excess
                self.clusters = {p: key for p, key in self.clusters.items() if p >= self.base}
            self.updated = time.monotonic()
            self.active = True
            self.condition.notify_all()

    def read(self, generation, cursor):
        with self.condition:
            end = self.base + len(self.data)
            reset = generation != self.generation or cursor < self.base
            if reset:
                keyframes = [p for p, key in self.clusters.items() if key is True]
                # Keep at least the previous GOP for a short, decodable live buffer.
                if not self.initialization or not keyframes:
                    return None
                cursor = keyframes[-3] if len(keyframes) >= 3 else keyframes[0]
            if cursor >= end:
                return None
            body = bytes(self.data[cursor - self.base:min(end, cursor + MAX_SEGMENT) - self.base])
            if reset:
                body = self.initialization + body
            return {"generation": self.generation, "cursor": min(end, cursor + MAX_SEGMENT),
                    "mime": self.mime, "reset": reset}, body

    def close(self):
        with self.condition:
            self.active = False
            self.data.clear()
            self.clusters.clear()
            self.initialization = b""
            self.pending.clear()
            self.condition.notify_all()
