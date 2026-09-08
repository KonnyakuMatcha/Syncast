"""Real Chromium/WebRTC checks using synthetic media, without screen/mic access.

Install playwright, then run: python tests/browser_functional.py
Set SYNCAST_TEST_BROWSER to a Chromium executable, or install Playwright Chromium.
"""

import os
from pathlib import Path
import sys
import threading
import time
import unittest

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


DISPLAY_FIXTURE = """
window.testCaptures = [];
navigator.mediaDevices.getDisplayMedia = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  let frame = 0;
  const timer = setInterval(() => {
    context.fillStyle = `hsl(${frame++ % 360}, 80%, 50%)`;
    context.fillRect(0, 0, 640, 360);
  }, 33);
  const stream = canvas.captureStream(30);
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


class QuietHandler(server.LiveHandler):
    def log_message(self, *args):
        pass


class BrowserFunctionalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'
        cls.playwright = sync_playwright().start()
        executable = os.environ.get('SYNCAST_TEST_BROWSER')
        cls.browser = cls.playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                  '--autoplay-policy=no-user-gesture-required',
                  '--disable-background-timer-throttling',
                  '--disable-renderer-backgrounding'],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.contexts = []
        self.errors = []

    def tearDown(self):
        for context in self.contexts:
            context.close()
        self.assertEqual(self.errors, [], 'Browser JavaScript errors')

    def page(self, name, code=None, denied=False):
        context = self.browser.new_context(permissions=['microphone'])
        self.contexts.append(context)
        context.add_init_script(DISPLAY_FIXTURE)
        if denied:
            context.add_init_script("""
              window.testGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia = async () => {
                throw new DOMException('Denied for test', 'NotAllowedError');
              };
            """)
        page = context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.set_default_timeout(15000)
        page.goto(self.base)
        page.locator('#display-name').fill(name)
        if code:
            page.locator('#room-code').fill(code)
            page.locator('#join-room').click()
        else:
            page.locator('#create-room').click()
        page.locator('#room').wait_for(state='visible')
        return page

    def wait_async(self, page, expression, arg=None, timeout=15):
        # Playwright's predicate polling must be synchronous. Await the
        # getStats promise explicitly, then poll its resolved boolean here.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if page.evaluate(expression, arg):
                return
            page.wait_for_timeout(100)
        self.fail('Timed out waiting for media statistics')

    def assert_receiving(self, page):
        baseline = page.evaluate("""async () => {
          const peer = state.stagePeers.get(state.stageParentId);
          const stats = peer ? [...(await peer.pc.getStats()).values()] : [];
          return {
            frames: stats.find(s => s.type === 'inbound-rtp' && s.kind === 'video')?.framesDecoded || 0,
            audio: stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.bytesReceived || 0,
          };
        }""")
        self.wait_async(page, """async before => {
          const peer = state.stagePeers.get(state.stageParentId);
          if (!peer) return false;
          const stats = [...(await peer.pc.getStats()).values()];
          return stats.some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > before.frames + 2)
            && stats.some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > before.audio);
        }""", arg=baseline)

    def freeze_receiving(self, sender, receiver, channel, kinds=('video', 'audio')):
        for page in [sender, receiver]:
            page.evaluate('clearInterval(state.healthTimer)')
        receiver.evaluate("""async ({channel, kinds}) => {
          const peer = channel === 'stage' ? state.stagePeers.get(state.stageParentId)
            : [...state.voicePeers.values()][0];
          window.testFrozenPeer = peer;
          window.testOriginalStats = peer.pc.getStats.bind(peer.pc);
          const frozen = await window.testOriginalStats();
          peer.pc.getStats = async () => new Map([...(await window.testOriginalStats())]
            .map(([id, report]) => [id, report.type === 'inbound-rtp' && kinds.includes(report.kind) ? frozen.get(id) || report : report]));
          peer.progress = undefined;
          window.testHealthTime = Date.now();
        }""", {'channel': channel, 'kinds': list(kinds)})
        sender_id = sender.evaluate('state.clientId')
        receiver_id = receiver.evaluate('state.clientId')
        previous = -1
        for step in range(6):
            self.wait_async(sender, """async ({id, channel, previous}) => {
              const peer = (channel === 'stage' ? state.stagePeers : state.voicePeers).get(id);
              const sample = SyncastHealth.summarizeStats(await peer.pc.getStats());
              return (channel === 'stage' ? sample.sentVideoFrames : sample.sentAudioBytes) > previous;
            }""", arg={'id': receiver_id, 'channel': channel, 'previous': previous})
            sender.evaluate('monitorConnections()')
            report = sender.evaluate('state.peerHealth.get(state.clientId)')
            previous = report['stage' if channel == 'stage' else 'links'][receiver_id][
                'videoFrames' if channel == 'stage' else 'audioBytes']
            receiver.wait_for_function('({id, serial}) => state.peerHealth.get(id)?.serial === serial',
                                       arg={'id': sender_id, 'serial': report['serial']})
            receiver.evaluate('step => monitorConnections(window.testHealthTime + step * 5000)', step)

    def test_connected_stage_stall_rebuilds_without_touching_voice(self):
        host = self.page('Host')
        guest = self.page('Guest', host.locator('#room-code-label').inner_text())
        host.locator('#share-button').click()
        self.assert_receiving(guest)
        guest.evaluate('window.testVoicePC = state.voicePeers.get(state.hostId).pc')
        before = host.evaluate("[...state.stagePeers.values()][0].pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1]")
        self.freeze_receiving(host, guest, 'stage')
        self.assertTrue(guest.evaluate('peerTransportConnected(window.testFrozenPeer)'))
        self.assertIn('停滞', guest.locator('#stage-connection-status').inner_text())
        self.assertEqual(guest.locator('#signal-status').inner_text(), '已连接')
        host.wait_for_function("old => [...state.stagePeers.values()][0].pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1] !== old", arg=before)
        guest.wait_for_function('state.stagePeers.get(state.stageParentId) !== window.testFrozenPeer', timeout=20000)
        self.assert_receiving(guest)
        guest.evaluate('monitorConnections()')
        guest.wait_for_function("document.querySelector('#stage-connection-status').textContent === '播放中'")
        self.assertTrue(guest.evaluate('state.voicePeers.get(state.hostId).pc === window.testVoicePC'))
        self.assertEqual(guest.evaluate('state.stagePeers.get(state.stageParentId).recoveryAttempts'), 0)

    def test_stage_audio_rebuild_keeps_budget_until_audio_returns(self):
        host = self.page('Host')
        guest = self.page('Guest', host.locator('#room-code-label').inner_text())
        host.locator('#share-button').click()
        self.assert_receiving(guest)
        guest.evaluate("""() => {
          const prototype = RTCPeerConnection.prototype;
          window.testPrototypeStats = prototype.getStats;
          const voicePC = state.voicePeers.get(state.hostId).pc;
          prototype.getStats = async function (...args) {
            const stats = await window.testPrototypeStats.apply(this, args);
            if (this === voicePC) return stats;
            return new Map([...stats].map(([id, report]) => [id,
              report.type === 'inbound-rtp' && report.kind === 'audio'
                ? {...report, bytesReceived: 0} : report]));
          };
        }""")
        self.freeze_receiving(host, guest, 'stage', kinds=('audio',))
        self.assertIn('声音停滞', guest.locator('#stage-connection-status').inner_text())
        guest.wait_for_function('state.stagePeers.get(state.stageParentId) !== window.testFrozenPeer', timeout=20000)
        self.wait_async(guest, """async () => {
          const peer = state.stagePeers.get(state.stageParentId);
          return peer && SyncastHealth.summarizeStats(await peer.pc.getStats()).videoFrames > 5;
        }""")
        guest.evaluate('monitorConnections()')
        self.assertTrue(guest.evaluate('state.stagePeers.get(state.stageParentId).recoveryAudioNeeded'))
        self.assertGreaterEqual(guest.evaluate('state.stagePeers.get(state.stageParentId).recoveryAttempts'), 2)
        guest.evaluate('() => { RTCPeerConnection.prototype.getStats = window.testPrototypeStats; }')
        self.assert_receiving(guest)
        guest.evaluate('monitorConnections()')
        self.assertEqual(guest.evaluate('state.stagePeers.get(state.stageParentId).recoveryAttempts'), 0)
        self.assertEqual(guest.locator('#stage-connection-status').inner_text(), '播放中')

    def test_voice_stall_manual_reconnect_preserves_live_stream(self):
        host = self.page('Host')
        guest = self.page('Guest', host.locator('#room-code-label').inner_text())
        host.locator('#share-button').click()
        self.assert_receiving(guest)
        guest.evaluate('window.testStagePC = state.stagePeers.get(state.stageParentId).pc; window.testClientId = state.clientId')
        self.freeze_receiving(host, guest, 'voice')
        self.assertIn('语音 · Host：声音停滞', guest.locator('#connection-details').inner_text())
        self.assertEqual(guest.locator('#stage-connection-status').inner_text(), '播放中')
        guest.evaluate("""() => {
          const peer = window.testFrozenPeer;
          clearTimeout(peer.recoveryTimer);
          peer.recoveryTimer = null;
          peer.recoveryExhausted = true;
          peer.recoveryAttempts = 3;
          peer.pc.getStats = window.testOriginalStats;
          renderConnectionStatus();
        }""")
        guest.locator('#reconnect-button').click()
        self.assertFalse(guest.evaluate('window.testFrozenPeer.recoveryExhausted'))
        self.wait_async(guest, """async () => {
          await monitorConnections();
          return !window.testFrozenPeer.mediaStalled;
        }""")
        self.assertEqual(guest.locator('#voice-status').inner_text(), '已连接 1/1')
        self.assertTrue(guest.evaluate('state.clientId === window.testClientId && state.stagePeers.get(state.stageParentId).pc === window.testStagePC'))
        self.assert_receiving(guest)

    def test_failed_join_releases_microphone(self):
        context = self.browser.new_context(permissions=['microphone'])
        self.contexts.append(context)
        context.add_init_script("""
          const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async constraints => {
            window.testMicrophone = await acquire(constraints);
            return window.testMicrophone;
          };
        """)
        page = context.new_page()
        page.goto(self.base)
        page.locator('#display-name').fill('Unsuccessful guest')
        page.locator('#room-code').fill('ABC234')
        page.locator('#join-room').click()
        page.wait_for_function("document.querySelector('#lobby-error').textContent.length > 0")
        self.assertFalse(page.evaluate('Boolean(state.microphone?.active)'),
                         'Failed room join leaves the microphone recording')
        self.assertTrue(page.evaluate("window.testMicrophone.getTracks().every(t => t.readyState === 'ended')"))
        page.locator('#create-room').click()
        page.locator('#room').wait_for(state='visible')
        self.assertTrue(page.evaluate('window.testMicrophone.active'))

    def test_denied_microphone_is_broadcast_as_muted(self):
        host = self.page('Host')
        guest = self.page('Viewer', host.locator('#room-code-label').inner_text(), denied=True)
        guest_id = guest.evaluate('state.clientId')
        host.wait_for_function('id => state.memberStates.has(id)', arg=guest_id)
        self.assertTrue(host.evaluate('id => state.memberStates.get(id).muted', guest_id))
        guest.evaluate('() => { navigator.mediaDevices.getUserMedia = window.testGetUserMedia; }')
        guest.locator('#mic-button').click()
        host.wait_for_function('id => state.memberStates.get(id)?.muted === false', arg=guest_id)
        self.wait_async(host, """async id => {
          const peer = state.voicePeers.get(id);
          if (!peer) return false;
          return [...(await peer.pc.getStats()).values()].some(s =>
            s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0);
        }""", arg=guest_id)

    def test_mobile_controls_fit_viewport(self):
        host = self.page('Mobile layout')
        for width in [320, 375, 390, 420]:
            with self.subTest(width=width):
                host.set_viewport_size({'width': width, 'height': 844})
                self.assertLessEqual(host.evaluate('document.documentElement.scrollWidth'), width)
                for selector in ['#mic-button', '#sound-button', '#share-button', '#leave-button', '#reconnect-button', '.connection-panel']:
                    box = host.locator(selector).bounding_box()
                    self.assertGreaterEqual(box['x'], 0)
                    self.assertLessEqual(box['x'] + box['width'], width)

    def test_voice_and_star_ice_restart(self):
        host = self.page('Host')
        guest = self.page('Guest', host.locator('#room-code-label').inner_text())
        guest_id = guest.evaluate('state.clientId')
        host_id = host.evaluate('state.clientId')
        host.locator('#share-button').click()
        self.assert_receiving(guest)
        for channel in ['voice', 'stage']:
            with self.subTest(channel=channel):
                # Inject an ICE failure notification into a real, connected
                # peer, then verify real SDP/ICE renegotiation and media flow.
                owner, remote = (host, guest) if channel == 'stage' or host_id < guest_id else (guest, host)
                collection = 'voicePeers' if channel == 'voice' else 'stagePeers'
                dropped = []

                def lose_first_offer(route):
                    data = route.request.post_data_json.get('data', {})
                    if data.get('channel') == channel and data.get('description', {}).get('type') == 'offer' and not dropped:
                        dropped.append(True)
                        route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
                    else:
                        route.continue_()

                owner.route('**/signal', lose_first_offer)
                before = owner.evaluate(f"[...state.{collection}.values()][0].pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1]")
                remote.evaluate(f"""() => {{
                  const pc = [...state.{collection}.values()][0].pc;
                  Object.defineProperty(pc, 'iceConnectionState', {{configurable: true, get: () => 'failed'}});
                  pc.oniceconnectionstatechange();
                }}""")
                owner.wait_for_function(f"old => [...state.{collection}.values()][0].pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1] !== old", arg=before)
                owner.wait_for_function(f"() => [...state.{collection}.values()][0].pc.signalingState === 'stable'")
                self.assertEqual(dropped, [True], 'The first restart offer should be lost and retried')
                owner.unroute('**/signal', lose_first_offer)
                remote.evaluate(f"""() => {{
                  const pc = [...state.{collection}.values()][0].pc;
                  delete pc.iceConnectionState;
                  pc.oniceconnectionstatechange();
                }}""")
                for page in [host, guest]:
                    page.wait_for_function(f"() => [...state.{collection}.values()][0].pc.connectionState === 'connected' && [...state.{collection}.values()][0].pc.signalingState === 'stable'")
                self.assert_receiving(guest)

    def test_recovery_stops_after_budget(self):
        host = self.page('Host')
        guest = self.page('Guest', host.locator('#room-code-label').inner_text())
        host.wait_for_function("() => [...state.voicePeers.values()].some(p => p.pc.connectionState === 'connected')")
        owner = host if host.evaluate('state.clientId') < guest.evaluate('state.clientId') else guest
        offers = []

        def lose_offers(route):
            data = route.request.post_data_json.get('data', {})
            if data.get('channel') == 'voice' and data.get('description', {}).get('type') == 'offer':
                offers.append(True)
                route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
            else:
                route.continue_()

        owner.route('**/signal', lose_offers)
        owner.evaluate("""() => {
          const pc = [...state.voicePeers.values()][0].pc;
          Object.defineProperty(pc, 'iceConnectionState', {configurable: true, get: () => 'failed'});
          pc.oniceconnectionstatechange();
        }""")
        owner.wait_for_function("document.querySelector('#toast').textContent.includes('未恢复')", timeout=35000)
        self.assertEqual(len(offers), 3)
        self.assertTrue(owner.evaluate("[...state.voicePeers.values()].every(p => p.recoveryAttempts === 3 && !p.recoveryTimer)"))

    def test_auto_relay_requires_sustained_pressure(self):
        host = self.page('Host')
        guests = [self.page(f'Guest {i}', host.locator('#room-code-label').inner_text()) for i in range(4)]
        host.locator('#share-button').click()
        for guest in guests:
            self.assert_receiving(guest)
        pressured_id = guests[0].evaluate('state.clientId')
        guests[0].evaluate('clearInterval(state.healthTimer)')
        guests[0].wait_for_function('!state.healthBusy')
        def report_pressure():
            serial = guests[0].evaluate("""async () => {
              const report = {serial: ++state.healthSerial, cpuLimited: true, links: {}, stage: {}};
              await sendSignal(state.hostId, {channel: 'peer-health', report});
              return report.serial;
            }""")
            host.wait_for_function('({id, serial}) => state.peerHealth.get(id)?.serial === serial',
                                   arg={'id': pressured_id, 'serial': serial})
        report_pressure()
        report_pressure()
        self.assertTrue(host.evaluate('id => freshPeerHealth().get(id).cpuLimited', pressured_id))
        host.evaluate('id => state.peerHealth.get(id).receivedAt -= 21000', pressured_id)
        self.assertFalse(host.evaluate('id => freshPeerHealth().has(id)', pressured_id))
        report_pressure()
        self.assertFalse(host.evaluate('id => freshPeerHealth().get(id).cpuLimited', pressured_id),
                         'An expired report must not count toward sustained encoding pressure')
        report_pressure()
        host.evaluate("""() => {
          clearInterval(state.topologyMonitorTimer);
          for (const peer of state.stagePeers.values()) {
            const getStats = peer.pc.getStats.bind(peer.pc);
            peer.pc.getStats = async () => {
              const stats = await getStats();
              return new Map([...stats].map(([id, report]) => [id,
                report.type === 'outbound-rtp' && report.kind === 'video'
                  ? {...report, qualityLimitationReason: 'bandwidth'} : report]));
            };
          }
        }""")
        for _ in range(2):
            host.evaluate('monitorTopology()')
            self.assertFalse(host.evaluate('state.topologyEnabled'))
        host.evaluate('monitorTopology()')
        host.wait_for_function('() => [...state.topologyNodes.values()].some(node => node.depth === 2)')
        leaf_id = host.evaluate('() => [...state.topologyNodes].find(([, node]) => node.depth === 2)[0]')
        self.assertEqual(leaf_id, pressured_id, 'Avoid assigning relay work to the CPU-limited participant')
        leaf = next(page for page in guests if page.evaluate('state.clientId') == leaf_id)
        leaf.wait_for_function('() => state.stageParentId !== state.hostId')
        self.assert_receiving(leaf)
        host.locator('#topology-mode').select_option('direct')
        leaf.wait_for_function('() => state.stageParentId === state.hostId')
        self.assert_receiving(leaf)
        host.evaluate('monitorTopology()')
        self.assertFalse(host.evaluate('state.topologyEnabled'), 'Manual direct mode must override the monitor')

    def test_share_tree_quality_restart_and_leave(self):
        host = self.page('Host')
        code = host.locator('#room-code-label').inner_text()
        guests = [self.page(f'Guest {i}', code) for i in range(4)]
        pages = [host, *guests]
        for page in pages:
            page.wait_for_function("""() => state.voicePeers.size === 4
              && [...state.voicePeers.values()].every(p => p.pc.connectionState === 'connected')""")
        host.locator('#share-button').click()
        for guest in guests:
            self.assert_receiving(guest)
        guests[0].locator('#mic-button').click()
        guest_id = guests[0].evaluate('state.clientId')
        host.wait_for_function('id => state.memberStates.get(id)?.muted', arg=guest_id)
        guests[0].locator('#quality-select').select_option('smooth')
        host.wait_for_function("id => state.stagePeers.get(id).pc.getSenders().find(s => s.track?.kind === 'video').getParameters().encodings[0].maxBitrate === 5000000", arg=guest_id)
        self.assertEqual(host.evaluate("""id => [...state.stagePeers]
          .filter(([peerId]) => peerId !== id)
          .map(([, peer]) => peer.pc.getSenders().find(s => s.track?.kind === 'video')
            .getParameters().encodings[0].maxBitrate)""", guest_id), [20000000] * 3)
        for guest in guests:
            guest.evaluate("window.testOldStream = state.stageStream; window.testOldParent = state.stageParentId")
            guest.evaluate("""() => {
          const send = sendSignal;
          sendSignal = async (id, data) => {
            if (data.channel === 'stage' && data.description?.type === 'offer' && !window.testReleased) {
              window.testOfferHeld = true;
              await new Promise(resolve => { window.testRelease = () => { window.testReleased = true; resolve(); }; });
            }
            return send(id, data);
          };
        }""")
        host.locator('#topology-mode').select_option('relay')
        host.wait_for_function('() => state.topologyEnabled && [...state.topologyNodes.values()].some(node => node.depth === 2)')
        leaf_id, relay_id = host.evaluate('() => { const [id, node] = [...state.topologyNodes].find(([, node]) => node.depth === 2); return [id, node.parentId]; }')
        by_id = {page.evaluate('state.clientId'): page for page in guests}
        leaf, relay = by_id[leaf_id], by_id[relay_id]
        unaffected = [page for page in guests if page not in [leaf, relay]]
        remaining = [page for page in guests if page != relay]
        leaf.wait_for_function('() => state.stageParentId !== state.hostId')
        relay.wait_for_function('() => window.testOfferHeld')
        self.assertTrue(leaf.evaluate('elements.stageVideo.srcObject === window.testOldStream'))
        baseline = leaf.evaluate("""async () => [...(await state.stagePeers.get(window.testOldParent).pc.getStats()).values()]
          .find(s => s.type === 'inbound-rtp' && s.kind === 'video').framesDecoded""")
        self.wait_async(leaf, """async before => [...(await state.stagePeers.get(window.testOldParent).pc.getStats()).values()]
          .some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > before + 2)""", arg=baseline)
        relay.evaluate('window.testRelease()')
        for guest in guests:
            guest.evaluate('window.testReleased = true')
        self.assert_receiving(leaf)
        leaf.wait_for_function('() => !state.stagePeers.has(window.testOldParent)')
        for page in pages:
            self.assertEqual(page.locator('#topology-map .topology-node').count(), 5)
        self.assertTrue(leaf.evaluate('state.sharedSoundEnabled'),
                        'Changing topology unexpectedly disables shared audio')
        leaf.locator('#sound-button').click()
        self.assertTrue(leaf.locator('#stage-video').evaluate('(v) => v.muted'))
        host.locator('#share-button').click()
        leaf.wait_for_function('() => state.stagePeers.size === 0')
        host.locator('#share-button').click()
        for guest in guests:
            self.assert_receiving(guest)
        self.assertTrue(leaf.locator('#stage-video').evaluate('(v) => v.muted'),
                        'Restarting the share unexpectedly unmutes the viewer')
        for guest in unaffected:
            guest.evaluate('window.testStablePeer = state.stagePeers.get(state.stageParentId).pc; window.testVoicePeer = state.voicePeers.get(state.hostId).pc')
        relay.locator('#leave-button').click()
        leaf.wait_for_function('() => state.stageParentId === state.hostId')
        self.assert_receiving(leaf)
        for guest in unaffected:
            self.assertTrue(guest.evaluate('state.stagePeers.get(state.stageParentId).pc === window.testStablePeer'))
            self.assertTrue(guest.evaluate('state.voicePeers.get(state.hostId).pc === window.testVoicePeer'))
        host.locator('#topology-mode').select_option('direct')
        for guest in remaining:
            guest.wait_for_function('() => !state.topologyEnabled')
            self.assert_receiving(guest)
        host.locator('#leave-button').click()
        for guest in remaining:
            guest.locator('#lobby').wait_for(state='visible')


if __name__ == '__main__':
    unittest.main(verbosity=2)
