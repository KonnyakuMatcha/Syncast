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
                for selector in ['#mic-button', '#sound-button', '#share-button', '#leave-button']:
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
        guests[3].wait_for_function('() => state.stageParentId !== state.hostId')
        self.assert_receiving(guests[3])
        host.locator('#topology-mode').select_option('direct')
        guests[3].wait_for_function('() => state.stageParentId === state.hostId')
        self.assert_receiving(guests[3])
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
        leaf = guests[3]
        leaf.evaluate("window.testOldStream = state.stageStream; window.testOldParent = state.stageParentId")
        guests[0].evaluate("""() => {
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
        host.wait_for_function('() => state.topologyEnabled')
        leaf.wait_for_function('() => state.stageParentId !== state.hostId')
        guests[0].wait_for_function('() => window.testOfferHeld')
        self.assertTrue(leaf.evaluate('elements.stageVideo.srcObject === window.testOldStream'))
        baseline = leaf.evaluate("""async () => [...(await state.stagePeers.get(window.testOldParent).pc.getStats()).values()]
          .find(s => s.type === 'inbound-rtp' && s.kind === 'video').framesDecoded""")
        self.wait_async(leaf, """async before => [...(await state.stagePeers.get(window.testOldParent).pc.getStats()).values()]
          .some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > before + 2)""", arg=baseline)
        guests[0].evaluate('window.testRelease()')
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
        for guest in guests[1:3]:
            guest.evaluate('window.testStablePeer = state.stagePeers.get(state.stageParentId).pc; window.testVoicePeer = state.voicePeers.get(state.hostId).pc')
        guests[0].locator('#leave-button').click()
        leaf.wait_for_function('() => state.stageParentId === state.hostId')
        self.assert_receiving(leaf)
        for guest in guests[1:3]:
            self.assertTrue(guest.evaluate('state.stagePeers.get(state.stageParentId).pc === window.testStablePeer'))
            self.assertTrue(guest.evaluate('state.voicePeers.get(state.hostId).pc === window.testVoicePeer'))
        host.locator('#topology-mode').select_option('direct')
        for guest in guests[1:]:
            guest.wait_for_function('() => !state.topologyEnabled')
            self.assert_receiving(guest)
        host.locator('#leave-button').click()
        for guest in guests[1:]:
            guest.locator('#lobby').wait_for(state='visible')


if __name__ == '__main__':
    unittest.main(verbosity=2)
