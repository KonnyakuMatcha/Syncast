import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import broadcast
import server


class BroadcastCleanupTests(unittest.TestCase):
    def test_room_and_participant_expiry_schedule_media_cleanup(self):
        store = server.RoomStore()
        room, host = store.create("Host")
        _, guest = store.join(room.code, "Guest")
        room.broadcast_used = True
        with patch.object(broadcast, "schedule_cleanup") as cleanup:
            guest.last_seen = time.time() - 46
            store.cleanup()
            cleanup.assert_called_once_with(room, guest.client_id)
            cleanup.reset_mock()
            host.last_seen = time.time() - 46
            store.cleanup()
            cleanup.assert_called_once_with(room)

    def test_room_deletion_and_member_removal_use_required_grants(self):
        config = {"api_url": "http://livekit:7880", "key": "key", "secret": "secret"}
        with patch.object(broadcast, "sign_token", return_value="jwt") as sign, \
                patch.object(broadcast, "urlopen", return_value=MagicMock()) as send:
            broadcast._remove(config, "room", None)
            sign.assert_called_with(config, {"video": {"roomCreate": True}})
            self.assertTrue(send.call_args.args[0].full_url.endswith("/DeleteRoom"))
            broadcast._remove(config, "room", "guest")
            sign.assert_called_with(config, {"video": {"roomAdmin": True, "room": "room"}})
            self.assertEqual(json.loads(send.call_args.args[0].data), {"room": "room", "identity": "guest"})


if __name__ == "__main__":
    unittest.main()
