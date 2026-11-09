import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import reliable


def vint_size(size):
    if size < 127:
        return bytes([0x80 | size])
    return (0x4000 | size).to_bytes(2, "big")


def cluster(key=True, value=b"test"):
    block = b"\x81\x00\x00" + (b"\x80" if key else b"\x00") + value
    return reliable.CLUSTER + b"\xe7\x81\x00\xa3" + vint_size(len(block)) + block


class ReliableRelayTests(unittest.TestCase):
    def test_blockgroup_reference_and_nondefault_video_track(self):
        block = b"\xa1\x85\x82\x00\x00\x00x"
        intra = reliable.CLUSTER + b"\xa0" + vint_size(len(block)) + block
        self.assertTrue(reliable._starts_with_keyframe(intra, 0, video_track=2))
        reference = block + b"\xfb\x81\xff"
        inter = reliable.CLUSTER + b"\xa0" + vint_size(len(reference)) + reference
        self.assertFalse(reliable._starts_with_keyframe(inter, 0, video_track=2))
        self.assertIsNone(reliable._starts_with_keyframe(intra[:-1], 0, video_track=2))
    def test_late_join_starts_with_initialization_and_keyframe(self):
        relay = reliable.Relay()
        relay.append("generation", 0, "video/webm;codecs=vp8,opus", b"init" + cluster())
        relay.append("generation", 1, "video/webm;codecs=vp8,opus", cluster(False))
        metadata, body = relay.read("", 0)
        self.assertTrue(metadata["reset"])
        self.assertTrue(body.startswith(b"init" + cluster()))
        self.assertIsNone(relay.read("generation", metadata["cursor"]))
        relay.append("generation", 2, "video/webm;codecs=vp8,opus", cluster())
        following, _ = relay.read("generation", metadata["cursor"])
        self.assertFalse(following["reset"])

    def test_marker_split_between_uploads_and_duplicate_ack(self):
        relay = reliable.Relay()
        raw = b"init" + cluster()
        relay.append("g", 0, "video/webm;codecs=vp8,opus", raw[:10])
        self.assertIsNone(relay.read("", 0))
        relay.append("g", 1, "video/webm;codecs=vp8,opus", raw[10:])
        before = bytes(relay.data)
        relay.append("g", 1, "video/webm;codecs=vp8,opus", raw[10:])
        self.assertEqual(bytes(relay.data), before)
        self.assertIsNotNone(relay.read("", 0))
        relay.append("g", 3, "video/webm;codecs=vp8,opus", b"later")
        self.assertEqual(bytes(relay.data), before)
        relay.append("g", 2, "video/webm;codecs=vp8,opus", b"earlier")
        self.assertTrue(bytes(relay.data).endswith(b"earlierlater"))
        with self.assertRaises(ValueError):
            relay.append("old-generation", 20, "video/webm;codecs=vp8,opus", b"stale")

    def test_cache_is_bounded_and_slow_viewer_can_restart(self):
        relay = reliable.Relay()
        relay.append("g", 0, "video/webm;codecs=vp8,opus", b"init" + cluster())
        original_limit = reliable.MAX_CACHE
        try:
            reliable.MAX_CACHE = 1000
            for i in range(1, 30):
                relay.append("g", i, "video/webm;codecs=vp8,opus", cluster(value=b"x" * 250))
            self.assertLessEqual(len(relay.data), reliable.MAX_CACHE)
            metadata, body = relay.read("g", 1)
            self.assertTrue(metadata["reset"])
            self.assertTrue(body.startswith(b"init" + reliable.CLUSTER))
        finally:
            reliable.MAX_CACHE = original_limit
        relay.close()
        self.assertFalse(relay.active)
        self.assertEqual(len(relay.data), 0)


if __name__ == "__main__":
    unittest.main()
