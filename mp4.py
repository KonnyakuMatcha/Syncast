"""Minimal fragmented-MP4 indexing for bounded live relay (no transcoding)."""

def boxes(data, start=0, end=None):
    end = len(data) if end is None else min(end, len(data))
    while start + 8 <= end:
        size = int.from_bytes(data[start:start + 4], "big")
        header = 8
        if size == 1:
            if start + 16 > end:
                return
            size = int.from_bytes(data[start + 8:start + 16], "big")
            header = 16
        if size < header or start + size > end:
            return
        yield bytes(data[start + 4:start + 8]), start, start + header, start + size
        start += size


def video_track(initialization):
    for kind, _, start, end in boxes(initialization):
        if kind != b"moov":
            continue
        for child, _, a, b in boxes(initialization, start, end):
            if child != b"trak":
                continue
            track_id, is_video = None, False
            for field, _, p, q in boxes(initialization, a, b):
                if field == b"tkhd" and q - p >= 24:
                    offset = 20 if initialization[p] == 1 else 12
                    track_id = int.from_bytes(initialization[p + offset:p + offset + 4], "big")
                if field == b"mdia":
                    for leaf, _, x, y in boxes(initialization, p, q):
                        if leaf == b"hdlr" and y - x >= 12:
                            is_video = initialization[x + 8:x + 12] == b"vide"
            if is_video and track_id is not None:
                return track_id
    return None


def keyframe(data, start, end, video_track_id):
    for kind, _, a, b in boxes(data, start, end):
        if kind != b"traf":
            continue
        track_id, default_flags, runs = None, None, []
        for field, _, p, q in boxes(data, a, b):
            if field == b"tfhd" and q - p >= 8:
                flags = int.from_bytes(data[p + 1:p + 4], "big")
                track_id = int.from_bytes(data[p + 4:p + 8], "big")
                offset = p + 8 + (8 if flags & 1 else 0) + (4 if flags & 2 else 0)
                offset += (4 if flags & 8 else 0) + (4 if flags & 16 else 0)
                if flags & 32 and offset + 4 <= q:
                    default_flags = int.from_bytes(data[offset:offset + 4], "big")
            elif field == b"trun":
                runs.append((p, q))
        if track_id != video_track_id:
            continue
        for p, q in runs:
            if q - p < 8 or int.from_bytes(data[p + 4:p + 8], "big") == 0:
                continue
            flags = int.from_bytes(data[p + 1:p + 4], "big")
            offset = p + 8 + (4 if flags & 1 else 0)
            sample_flags = default_flags
            if flags & 4:
                if offset + 4 > q:
                    return False
                sample_flags = int.from_bytes(data[offset:offset + 4], "big")
            elif flags & 0x400:
                offset += (4 if flags & 0x100 else 0) + (4 if flags & 0x200 else 0)
                if offset + 4 > q:
                    return False
                sample_flags = int.from_bytes(data[offset:offset + 4], "big")
            return sample_flags is not None and not bool(sample_flags & 0x10000)
    return False
