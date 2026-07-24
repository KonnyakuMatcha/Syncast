"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEM_AUDIO_BITRATE,
  enhanceSystemAudio,
  isIsolatedAudioSafe,
  isRelayCandidate,
  stripRelayCandidates,
} = require("../static/media.js");

const offer = {
  type: "offer",
  sdp: [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1",
    "",
  ].join("\r\n"),
};

const enhanced = enhanceSystemAudio(offer);
assert.equal(SYSTEM_AUDIO_BITRATE, 192_000);
assert.match(enhanced.sdp, /a=fmtp:111 .*stereo=1/);
assert.match(enhanced.sdp, /sprop-stereo=1/);
assert.match(enhanced.sdp, /maxaveragebitrate=192000/);
assert.match(enhanced.sdp, /usedtx=0/);
assert.doesNotMatch(enhanced.sdp, /usedtx=1/);
assert.equal((enhanced.sdp.match(/useinbandfec=/g) || []).length, 1);

const withoutFmtp = enhanceSystemAudio({
  type: "answer",
  sdp: "v=0\r\na=rtpmap:109 opus/48000/2\r\n",
});
assert.match(withoutFmtp.sdp, /a=rtpmap:109 opus\/48000\/2\r\na=fmtp:109 /);

assert.equal(isIsolatedAudioSafe("browser"), true);
assert.equal(isIsolatedAudioSafe("window"), true);
assert.equal(isIsolatedAudioSafe("monitor"), false);
assert.equal(isIsolatedAudioSafe(undefined), false);

assert.equal(isRelayCandidate({ candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host" }), false);
assert.equal(isRelayCandidate({ candidate: "candidate:2 1 udp 1 198.51.100.1 6000 typ srflx" }), false);
assert.equal(isRelayCandidate({ candidate: "candidate:3 1 udp 1 203.0.113.1 3478 typ relay" }), true);

const p2pOnly = stripRelayCandidates({
  type: "offer",
  sdp: [
    "v=0",
    "a=candidate:1 1 udp 1 192.0.2.1 5000 typ host",
    "a=candidate:2 1 udp 1 203.0.113.1 3478 typ relay",
    "a=end-of-candidates",
    "",
  ].join("\r\n"),
});
assert.match(p2pOnly.sdp, /typ host/);
assert.doesNotMatch(p2pOnly.sdp, /typ relay/);

console.log("system audio SDP tests passed");
