import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mp4
import reliable


def box(kind, payload, extended=False):
    if extended:
        return b"\x00\x00\x00\x01" + kind + (len(payload) + 16).to_bytes(8, "big") + payload
    return (len(payload) + 8).to_bytes(4, "big") + kind + payload


def track(track_id, handler):
    return box(b"trak", box(b"tkhd", b"\x01\x00\x00\x03" + b"\0" * 16 + track_id.to_bytes(4, "big"))
               + box(b"mdia", box(b"hdlr", b"\0" * 8 + handler)))


INIT = box(b"ftyp", b"iso5") + box(b"moov", track(1, b"soun") + track(2, b"vide"))


def fragment(sync=True, first_flags=True):
    default = 0x1010000
    tfhd = box(b"tfhd", b"\x00\x02\x00\x20" + (2).to_bytes(4, "big") + default.to_bytes(4, "big"))
    flags = 0x5 if first_flags else 0x401
    sample_flags = 0x02000000 if sync else 0x01010000
    trun = box(b"trun", flags.to_bytes(4, "big") + (1).to_bytes(4, "big")
               + b"\0" * 4 + sample_flags.to_bytes(4, "big"))
    return box(b"moof", box(b"traf", tfhd + trun)) + box(b"mdat", b"encoded-video")


class FragmentedMP4Tests(unittest.TestCase):
    def test_platform_avc_profiles_are_supported_but_other_media_are_rejected(self):
        self.assertTrue(reliable.supported_mime("video/mp4;codecs=avc1.42e01f,mp4a.40.2"))
        self.assertTrue(reliable.supported_mime("video/mp4;codecs=avc1.64002a"))
        self.assertFalse(reliable.supported_mime("video/mp4;codecs=avc1.invalid,mp4a.40.2"))
        self.assertFalse(reliable.supported_mime("audio/mp4;codecs=mp4a.40.2"))

    def test_video_track_is_identified_by_handler_not_track_order(self):
        self.assertEqual(mp4.video_track(INIT), 2)

    def test_fragment_keyframe_flags_and_partial_boxes(self):
        for first in [True, False]:
            for sync in [True, False]:
                data = fragment(sync, first)
                kind, _, start, end = next(mp4.boxes(data))
                self.assertEqual(kind, b"moof")
                self.assertEqual(mp4.keyframe(data, start, end, 2), sync)
        data = box(b"mdat", b"x" * 100, extended=True)
        self.assertEqual(list(mp4.boxes(data[:-1])), [])
        self.assertEqual(len(list(mp4.boxes(data))), 1)
        self.assertEqual(list(mp4.boxes(b"\0" * 8)), [])

    def test_out_of_order_fragment_uploads_and_late_join(self):
        stream = INIT + fragment(True) + fragment(False) + fragment(True)
        mime = "video/mp4;codecs=avc1.4d0028,mp4a.40.2"
        relay = reliable.Relay()
        cuts = [stream[i:i + 19] for i in range(0, len(stream), 19)]
        relay.append("generation", 1, mime, cuts[1])
        relay.append("generation", 0, mime, cuts[0])
        for i in range(2, len(cuts)):
            relay.append("generation", i, mime, cuts[i])
        self.assertEqual(relay.initialization, INIT)
        self.assertEqual(relay.video_track, 2)
        self.assertEqual(list(relay.clusters.values()), [True, False, True])
        metadata, body = relay.read("", 0)
        self.assertTrue(metadata["reset"])
        self.assertEqual(body, stream)
        self.assertEqual(metadata["mime"], mime)
        self.assertIsNone(relay.read(metadata["generation"], metadata["cursor"]))


if __name__ == "__main__":
    unittest.main()
