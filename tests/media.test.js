"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEM_AUDIO_BITRATE,
  enhanceSystemAudio,
  getWindowAudioPreference,
  isIsolatedAudioSafe,
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
assert.equal(isIsolatedAudioSafe("window", "isolated"), true);
assert.equal(isIsolatedAudioSafe("window", "system"), false);
assert.equal(isIsolatedAudioSafe("monitor"), false);
assert.equal(isIsolatedAudioSafe(undefined), false);
assert.equal(getWindowAudioPreference("isolated"), "window");
assert.equal(getWindowAudioPreference("system"), "system");
assert.equal(getWindowAudioPreference("unexpected"), "window");

console.log("system audio SDP tests passed");
