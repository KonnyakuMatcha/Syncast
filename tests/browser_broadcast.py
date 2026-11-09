"""Real SFU checks. Set SYNCAST_TEST_LIVEKIT to a livekit-server binary.

Uses local-only services, synthetic video/audio and Playwright Chromium.
"""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen

import browser_functional as functional


BROADCAST_DISPLAY_FIXTURE = """
window.testCaptures = [];
navigator.mediaDevices.getDisplayMedia = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext('2d');
  let frame = 0;
  const timer = setInterval(() => {
    context.fillStyle = `hsl(${frame++ % 360}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 16);
  const stream = canvas.captureStream(60);
  const audio = new AudioContext();
  await audio.resume();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  stream.addTrack(destination.stream.getAudioTracks()[0]);
  window.testCaptures.push({canvas, timer, audio, oscillator, stream});
  return stream;
};
"""


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(os.environ.get("SYNCAST_TEST_LIVEKIT"), "Set SYNCAST_TEST_LIVEKIT to test real SFU media")
class BroadcastFunctionalTests(unittest.TestCase):
    setUp = functional.BrowserFunctionalTests.setUp
    tearDown = functional.BrowserFunctionalTests.tearDown
    page = functional.BrowserFunctionalTests.page
    wait_async = functional.BrowserFunctionalTests.wait_async
    assert_receiving_p2p = functional.BrowserFunctionalTests.assert_receiving

    @classmethod
    def setUpClass(cls):
        cls.display_fixture = patch.object(functional, "DISPLAY_FIXTURE", BROADCAST_DISPLAY_FIXTURE)
        cls.display_fixture.start()
        cls.addClassCleanup(cls.display_fixture.stop)
        cls.temp = tempfile.TemporaryDirectory(prefix="syncast-broadcast-")
        cls.addClassCleanup(cls.temp.cleanup)
        port, tcp, udp = free_port(), free_port(), free_port()
        config = {
            "port": port, "bind_addresses": ["127.0.0.1"],
            "rtc": {"node_ip": "127.0.0.1", "use_external_ip": False,
                    "enable_loopback_candidate": True, "tcp_port": tcp, "udp_port": udp},
            "keys": {"testkey": "0123456789abcdef0123456789abcdef"},
            "logging": {"level": "warn"},
        }
        log = open(Path(cls.temp.name) / "livekit.log", "w+")
        cls.addClassCleanup(log.close)
        cls.sfu = subprocess.Popen([os.environ["SYNCAST_TEST_LIVEKIT"], "--config-body", json.dumps(config)], stdout=log, stderr=log)

        def stop_sfu():
            cls.sfu.terminate()
            try:
                cls.sfu.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.sfu.kill()
                cls.sfu.wait()

        cls.addClassCleanup(stop_sfu)
        for _ in range(100):
            try:
                with urlopen(f"http://127.0.0.1:{port}", timeout=1):
                    break
            except OSError:
                if cls.sfu.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                time.sleep(0.1)
        else:
            raise RuntimeError("LiveKit did not start")
        cls.environment = patch.dict(os.environ, {
            "SYNCAST_BROADCAST_ENABLED": "true",
            "SYNCAST_LIVEKIT_URL": f"ws://127.0.0.1:{port}",
            "SYNCAST_LIVEKIT_API_URL": f"http://127.0.0.1:{port}",
            "LIVEKIT_API_KEY": "testkey",
            "LIVEKIT_API_SECRET": config["keys"]["testkey"],
        })
        cls.environment.start()
        cls.addClassCleanup(cls.environment.stop)
        functional.BrowserFunctionalTests.setUpClass.__func__(cls)
        cls.addClassCleanup(functional.BrowserFunctionalTests.tearDownClass.__func__, cls)

    def assert_receiving(self, page):
        page.wait_for_function("state.broadcastClient?.room?.state === 'connected'", timeout=30000)
        stats = """async () => {
          const remote = state.broadcastClient?.room?.remoteParticipants.get(state.hostId);
          let frames = 0, audio = 0;
          for (const pub of remote?.trackPublications.values() || []) {
            if (!['screen_share', 'screen_share_audio'].includes(pub.source)) continue;
            const reports = await pub.track?.getRTCStatsReport();
            for (const report of reports?.values() || []) {
              if (report.type !== 'inbound-rtp') continue;
              if (report.kind === 'video') frames += report.framesDecoded || 0;
              if (report.kind === 'audio') audio += report.bytesReceived || 0;
            }
          }
          return {frames, audio, client: remote?.sid};
        }"""
        baseline = page.evaluate(stats)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            current = page.evaluate(stats)
            if current["client"] != baseline["client"]:
                baseline = current
                continue
            if current["frames"] > baseline["frames"] + 2 and current["audio"] > baseline["audio"]:
                self.assertEqual(page.evaluate("state.stagePeers.size"), 0)
                self.assertFalse(page.locator("#resolution-select").is_disabled())
                self.assertFalse(page.locator("#frame-rate-select").is_disabled())
                return
            page.wait_for_timeout(100)
        self.fail(f"SFU media did not advance: {baseline} -> {current}")

    def assert_voices(self, pages):
        ids = [page.evaluate("state.clientId") for page in pages]
        for page, local_id in zip(pages, ids):
            remote_ids = [identity for identity in ids if identity != local_id]
            page.wait_for_function("ids => ids.every(id => state.broadcastClient?.remoteVoices.has(id))", arg=remote_ids)
            snapshot = """async ids => Object.fromEntries(await Promise.all(ids.map(async id => {
              const track = state.broadcastClient.remoteVoices.get(id);
              const stats = await track?.getRTCStatsReport();
              return [id, [...(stats?.values() || [])].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio')
                .reduce((sum, s) => sum + s.bytesReceived, 0)];
            })))"""
            baseline = page.evaluate(snapshot, remote_ids)
            self.wait_async(page, """async baseline => {
              for (const [id, before] of Object.entries(baseline)) {
                const track = state.broadcastClient.remoteVoices.get(id);
                const stats = await track?.getRTCStatsReport();
                if (![...(stats?.values() || [])].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > before)) return false;
                const audio = document.getElementById(`voice-${id}`);
                if (!audio || audio.paused || audio.muted || audio.readyState < 2) return false;
              }
              return true;
            }""", arg=baseline)
            self.assertEqual(page.evaluate("state.voicePeers.size"), 0)
            self.assertIn("服务器语音", page.locator("#voice-status").inner_text())

    def assert_p2p_voices(self, pages):
        for page in pages:
            self.wait_async(page, """async count => {
              if (state.voicePeers.size !== count) return false;
              for (const peer of state.voicePeers.values()) {
                if (!peerTransportConnected(peer)) return false;
                const stats = [...(await peer.pc.getStats()).values()];
                if (!stats.some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0)) return false;
              }
              return true;
            }""", arg=len(pages) - 1)

    def test_single_upload_multi_viewer_switch_restart_reconnect_and_close(self):
        host = self.page("Host")
        host.evaluate("state.broadcastProfile = 'balanced'")
        code = host.locator("#room-code-label").inner_text()
        first = self.page("First", code)
        host.locator("#share-button").click()
        self.assert_receiving_p2p(first)
        host.evaluate("window.originalCapture = state.display; window.voicePC = [...state.voicePeers.values()][0].pc")
        host.locator("#topology-mode").select_option("server")
        self.assert_receiving(first)
        guests = [first, self.page("Second", code), self.page("Third", code)]
        for guest in guests[1:]:
            self.assert_receiving(guest)
        expected_levels = [("720", "30", "LOW"), ("1080", "30", "HIGH"), ("1080", "60", "HIGH")]
        for guest, (resolution, frame_rate, level) in zip(guests, expected_levels):
            guest.locator("#resolution-select").select_option(resolution)
            guest.locator("#frame-rate-select").select_option(frame_rate)
            guest.wait_for_function(
                "expected => {"
                " const publication = state.broadcastClient?.room?.remoteParticipants.get(state.hostId)"
                "   ?.getTrackPublication('screen_share');"
                " return publication?.videoQuality === window.LivekitClient.VideoQuality[expected.level]"
                "   && publication?.fps === expected.fps;"
                "}",
                arg={"level": level, "fps": int(frame_rate)},
            )
        first.locator("#frame-rate-select").select_option("60")
        first.wait_for_function("""() => {
          const publication = state.broadcastClient?.room?.remoteParticipants
            .get(state.hostId)?.getTrackPublication('screen_share');
          return publication?.videoQuality === window.LivekitClient.VideoQuality.LOW
            && publication?.fps === 60;
        }""")
        first.locator("#frame-rate-select").select_option("30")
        first.wait_for_function("""() => {
          const publication = state.broadcastClient?.room?.remoteParticipants
            .get(state.hostId)?.getTrackPublication('screen_share');
          return publication?.videoQuality === window.LivekitClient.VideoQuality.LOW
            && publication?.fps === 30;
        }""")
        self.assertEqual(first.evaluate(
            "state.broadcastClient.room.remoteParticipants.get(state.hostId)"
            ".getTrackPublication('screen_share').videoQuality"),
            first.evaluate("window.LivekitClient.VideoQuality.LOW"),
        )
        host.wait_for_function("state.broadcastClient?.source === state.display")
        self.assertTrue(host.evaluate("state.display === window.originalCapture && window.voicePC.connectionState === 'closed'"))
        self.assert_voices([host, *guests])
        for guest in guests[1:]:
            self.assertEqual(guest.evaluate("window.testVoiceSignals"), [])
        stats = host.evaluate("""async () => {
          const publications = [...state.broadcastClient.room.localParticipant.trackPublications.values()];
          const video = publications.find(pub => pub.kind === 'video').track;
          const reports = [...(await video.getRTCStatsReport()).values()];
          return {tracks: publications.length, peers: state.stagePeers.size,
            encodings: video.sender.getParameters().encodings.length,
            encodingDetails: video.sender.getParameters().encodings.map(encoding => ({
              rid: encoding.rid, maxBitrate: encoding.maxBitrate,
              maxFramerate: encoding.maxFramerate, scaleResolutionDownBy: encoding.scaleResolutionDownBy})),
            degradation: video.sender.getParameters().degradationPreference,
            streams: reports.filter(s => s.type === 'outbound-rtp' && s.kind === 'video' && s.framesEncoded > 0).length};
        }""")
        self.assertEqual(stats["tracks"], 3)
        self.assertEqual(stats["peers"], 0)
        self.assertEqual(stats["encodings"], 2)
        self.assertEqual(stats["degradation"], "maintain-framerate")
        self.assertEqual(stats["encodingDetails"], [
            {"rid": "q", "maxBitrate": 2_000_000, "maxFramerate": 60, "scaleResolutionDownBy": 1.5},
            {"rid": "h", "maxBitrate": 6_000_000, "maxFramerate": 60, "scaleResolutionDownBy": 1},
        ])
        self.assertGreaterEqual(stats["streams"], 1)
        self.assertIn("均衡", host.locator("#stage-connection-status").inner_text())
        self.assertIn("广播服务器", first.locator("#topology-map").inner_text())

        host.locator("#sound-button").click()
        self.assertTrue(host.evaluate("state.broadcastClient.tracks.filter(t => t.kind === 'audio').every(t => !t.enabled)"))
        self.assertTrue(host.evaluate("state.broadcastClient.microphoneTrack.enabled"))
        self.assert_voices([host, first])
        host.locator("#sound-button").click()
        first.locator("#sound-button").click()
        self.assertTrue(first.evaluate("document.querySelector('#stage-video').muted"))
        self.assert_voices([host, first])
        first.locator("#reconnect-button").click()
        self.assert_receiving(first)
        self.assertTrue(first.evaluate("document.querySelector('#stage-video').muted"))

        host.locator("#reconnect-button").click()
        for guest in guests:
            self.assert_receiving(guest)
        self.assert_voices([host, *guests])
        host.locator("#topology-mode").select_option("direct")
        for guest in guests:
            self.assert_receiving_p2p(guest)
            self.assertFalse(guest.locator("#resolution-select").is_disabled())
            self.assertFalse(guest.locator("#frame-rate-select").is_disabled())
        self.assertTrue(host.evaluate("state.display.active && state.broadcastClient === null"))
        self.assert_p2p_voices([host, *guests])
        host.locator("#topology-mode").select_option("server")
        for guest in guests:
            self.assert_receiving(guest)

        host.evaluate("window.voiceClient = state.broadcastClient; window.micTrack = state.broadcastClient.microphoneTrack")
        host.locator("#share-button").click()
        first.wait_for_function("!state.stageExpected && document.querySelector('#stage-video').srcObject === null")
        host.wait_for_function("state.broadcastClient.tracks.length === 0")
        self.assertTrue(host.evaluate("state.broadcastClient === window.voiceClient && window.micTrack === state.broadcastClient.microphoneTrack"))
        self.assert_voices([host, *guests])
        host.locator("#share-button").click()
        for guest in guests:
            self.assert_receiving(guest)
        self.assertTrue(first.evaluate("document.querySelector('#stage-video').muted"))
        host.locator("#leave-button").click()
        for guest in guests:
            guest.locator("#lobby").wait_for(state="visible")

    def test_unavailable_sfu_is_visible_and_can_return_to_p2p(self):
        host = self.page("Host")
        guest = self.page("Guest", host.locator("#room-code-label").inner_text())
        host.route("**/broadcast-token", lambda route: route.fulfill(
            status=503, content_type="application/json", body='{"error":"SFU unavailable"}'))
        host.locator("#topology-mode").select_option("server")
        host.locator("#share-button").click()
        host.wait_for_function("state.stageExpected")
        host.wait_for_function("state.broadcastClient?.status === 'failed'")
        self.assertIn("广播连接失败", host.locator("#stage-connection-status").inner_text())
        self.assertIn("服务器语音连接失败", host.locator("#voice-status").inner_text())
        host.evaluate("reconnectMedia()")
        host.wait_for_function("state.broadcastClient?.status === 'failed'")
        self.assertEqual(host.evaluate("state.voicePeers.size"), 0)
        host.locator("#topology-mode").select_option("direct")
        self.assert_receiving_p2p(guest)
        host.locator("#leave-button").click()

    def test_stop_while_connecting_does_not_publish_a_stale_capture(self):
        host = self.page("Host")
        guest = self.page("Guest", host.locator("#room-code-label").inner_text())
        pending = []
        host.route("**/broadcast-token", lambda route: pending.append(route))
        host.locator("#topology-mode").select_option("server")
        host.locator("#share-button").click()
        deadline = time.monotonic() + 5
        while not pending and time.monotonic() < deadline:
            host.wait_for_timeout(50)
        self.assertTrue(pending)
        host.evaluate("window.staleClient = state.broadcastClient")
        host.locator("#share-button").click()
        pending[0].continue_()
        self.assertTrue(host.evaluate("!window.staleClient.closed && state.broadcastClient === window.staleClient && state.display === null"))
        guest.wait_for_function("!state.stageExpected")
        self.assert_voices([host, guest])
        self.assertEqual(host.evaluate("[...state.broadcastClient.room.localParticipant.trackPublications.values()].map(p => p.source)"), ["microphone"])
        host.unroute("**/broadcast-token")
        host.locator("#share-button").click()
        self.assert_receiving(guest)
        host.locator("#leave-button").click()

    def test_server_voice_without_screen_muting_and_denied_microphone(self):
        host = self.page("Host", server_mode=True)
        code = host.locator("#room-code-label").inner_text()
        first = self.page("First", code)
        denied = self.page("Listener", code, denied=True)
        self.assert_voices([host, first])
        host_id, first_id = host.evaluate("state.clientId"), first.evaluate("state.clientId")
        self.wait_async(denied, """async ids => {
          for (const id of ids) {
            const track = state.broadcastClient?.remoteVoices.get(id);
            const stats = await track?.getRTCStatsReport();
            if (![...(stats?.values() || [])].some(s => s.type === 'inbound-rtp' && s.bytesReceived > 0)) return false;
          }
          return true;
        }""", arg=[host_id, first_id])
        for page in [host, first, denied]:
            self.assertEqual(page.evaluate("window.testVoiceSignals"), [])
            self.assertEqual(page.evaluate("state.voicePeers.size + state.stagePeers.size"), 0)
            self.assertIsNone(page.evaluate("state.display"))
        first.locator("#mic-button").click()
        first.wait_for_function("state.broadcastClient.microphonePublication.track.isMuted")
        host.wait_for_function("id => state.broadcastClient.room.remoteParticipants.get(id)?.getTrackPublication('microphone')?.isMuted", arg=first_id)
        self.assertFalse(first.evaluate("state.broadcastClient.microphoneTrack.enabled"))
        first.locator("#reconnect-button").click()
        first.wait_for_function("state.broadcastClient.microphonePublication?.track.isMuted")
        self.assertFalse(first.evaluate("state.broadcastClient.microphoneTrack.enabled"))
        first.locator("#mic-button").click()
        self.assert_voices([host, first])
        denied.evaluate("() => { navigator.mediaDevices.getUserMedia = window.testGetUserMedia; }")
        denied.locator("#mic-button").click()
        self.assert_voices([host, first, denied])
        denied_id = denied.evaluate("state.clientId")
        denied.locator("#leave-button").click()
        host.wait_for_function("id => !state.broadcastClient.remoteVoices.has(id) && !document.getElementById(`voice-${id}`)", arg=denied_id)
        self.assert_voices([host, first])
        host.locator("#leave-button").click()

    def test_live_playback_not_reloaded_by_mic_or_members_and_reports_media_stats(self):
        host = self.page("Host", server_mode=True)
        code = host.locator("#room-code-label").inner_text()
        guest = self.page("Guest", code)
        host.locator("#share-button").click()
        self.assert_receiving(guest)
        self.assert_voices([host, guest])
        guest.evaluate("""() => {
          window.playerReloads = 0;
          document.querySelector('#stage-video').addEventListener('loadstart', () => window.playerReloads++);
        }""")
        guest.locator("#mic-button").click()
        guest.wait_for_function("state.broadcastClient.microphonePublication.track.isMuted")
        guest.locator("#mic-button").click()
        late = self.page("Late", code)
        self.assert_receiving(late)
        self.assert_receiving(guest)
        late.locator("#leave-button").click()
        guest.wait_for_function("state.participants.size === 2")
        self.assert_receiving(guest)
        self.assertEqual(guest.evaluate("window.playerReloads"), 0, "Updating an unchanged MediaStream must not reload the player")
        for page in [host, guest]:
            page.evaluate("state.broadcastClient.sampleMediaStats()")
        self.assert_receiving(guest)
        for page in [host, guest]:
            page.evaluate("monitorConnections()")
            self.wait_async(page, """async () => {
              await monitorConnections();
              const stats = state.broadcastClient.mediaStats;
              return stats?.videoMbps > 0 && stats.audioMbps > 0
                && stats.streams.some(s => s.fps > 0);
            }""")
            page.locator("#broadcast-diagnostics summary").click()
            text = page.locator("#broadcast-stats").inner_text()
            self.assertIn("Mbps", text)
            self.assertIn("共享声音", text)
            self.assertNotIn("NaN", text)
            self.assertNotIn("Infinity", text)
        self.assertIn("本机 → VPS", host.locator("#broadcast-stats").inner_text())
        self.assertIn("VPS → 本机", guest.locator("#broadcast-stats").inner_text())
        host.locator("#share-button").click()
        guest.wait_for_function("!state.stageExpected")
        self.assertTrue(guest.locator("#broadcast-diagnostics").is_hidden())
        self.assert_voices([host, guest])
        host.locator("#leave-button").click()

    def test_lost_mode_response_and_delayed_join_recover_live_video(self):
        host = self.page("Host", server_mode=True)
        code = host.locator("#room-code-label").inner_text()
        host.locator("#share-button").click()
        original = functional.QuietHandler.room_response

        def delayed(handler, room, participant):
            if participant.client_id != room.host_id:
                deadline = time.monotonic() + 3
                while room.stage_version < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
            return original(handler, room, participant)

        with patch.object(functional.QuietHandler, "room_response", delayed):
            guest = self.page("Guest", code)
        self.assert_receiving(guest)

        def lose_response(route):
            route.fetch()
            route.abort("failed")

        host.route("**/transport", lose_response)
        host.locator("#topology-mode").select_option("direct")
        self.assert_receiving_p2p(guest)
        host.wait_for_function("state.topologyMode === 'direct' && !elements.topologyMode.disabled")
        host.unroute("**/transport")
        host.locator("#topology-mode").select_option("server")
        self.assert_receiving(guest)
        guest.evaluate("state.stageExpected = false; state.topologyVersion = 0; showStage(false)")
        guest.locator("#reconnect-button").click()
        self.assert_receiving(guest)
        host.locator("#leave-button").click()

    def test_broadcast_profile_replaces_video_and_preserves_audio(self):
        host = self.page("Host", server_mode=True)
        self.assertEqual(host.evaluate("state.broadcastProfile"), "quality")
        host.locator("#broadcast-profile").select_option("balanced")
        guest = self.page("Guest", host.locator("#room-code-label").inner_text())
        host.locator("#share-button").click()
        self.assert_receiving(guest)
        host.evaluate("window.keptMic = state.broadcastClient.microphoneTrack; window.keptSound = state.broadcastClient.tracks.find(t => t.kind === 'audio')")
        host.locator("#broadcast-profile").select_option("smooth")
        host.wait_for_function("state.broadcastClient.profile === 'smooth'")
        self.assert_receiving(guest)
        details = host.evaluate("""() => {
          const track = state.broadcastClient.room.localParticipant.getTrackPublication('screen_share').track;
          return {encodings: track.sender.getParameters().encodings, settings: track.mediaStreamTrack.getSettings(),
            audioKept: window.keptSound === state.broadcastClient.tracks.find(t => t.kind === 'audio'),
            micKept: window.keptMic === state.broadcastClient.microphoneTrack};
        }""")
        self.assertEqual(len(details["encodings"]), 1)
        self.assertEqual(details["encodings"][0]["maxBitrate"], 2_000_000)
        self.assertLessEqual(details["settings"]["height"], 720)
        self.assertTrue(details["audioKept"])
        self.assertTrue(details["micKept"])
        host.locator("#broadcast-profile").select_option("balanced")
        host.wait_for_function("state.broadcastClient.profile === 'balanced'")
        self.assert_receiving(guest)
        self.assert_voices([host, guest])
        host.locator("#broadcast-profile").select_option("quality")
        host.wait_for_function("state.broadcastClient.profile === 'quality'")
        caps = host.evaluate("state.broadcastClient.room.localParticipant.getTrackPublication('screen_share').track.sender.getParameters().encodings.map(e => e.maxBitrate)")
        self.assertEqual(caps, [5_000_000, 20_000_000])
        self.assert_receiving(guest)
        host.locator("#broadcast-bitrate").select_option("40")
        host.wait_for_function("state.broadcastClient.maxMbps === 40")
        caps = host.evaluate("state.broadcastClient.room.localParticipant.getTrackPublication('screen_share').track.sender.getParameters().encodings.map(e => e.maxBitrate)")
        self.assertEqual(caps, [5_000_000, 40_000_000])
        self.assertTrue(host.evaluate("window.keptSound === state.broadcastClient.tracks.find(t => t.kind === 'audio') && window.keptMic === state.broadcastClient.microphoneTrack"))
        self.assert_receiving(guest)
        host.locator("#leave-button").click()


if __name__ == "__main__":
    unittest.main(verbosity=2)
