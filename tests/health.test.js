"use strict";
const assert = require("node:assert/strict");
const { updateProgress, sanitizeReport, summarizeStats } = require("../static/health.js");

const sample = { videoId: "v", audioId: "a", videoFrames: 10, videoBytes: 1000, audioBytes: 200 };
const sender = { peerId: "parent", serial: 1, videoId: "sv", audioId: "sa", videoFrames: 10, audioBytes: 200 };
function scenario({ sending = true, video = true, audio = true, decodeBytes = false } = {}) {
  let progress;
  for (let i = 0; i <= 5; i++) {
    progress = updateProgress(progress, { ...sample, videoBytes: sample.videoBytes + (decodeBytes ? i * 100 : 0) }, {
      video, audio, source: { ...sender, serial: i + 1, videoFrames: sending ? 10 + i : 10, audioBytes: sending ? 200 + i * 20 : 200 },
    }, i * 5000);
  }
  return progress;
}

assert.equal(scenario().videoStalled, true, "Sending without receiving must trigger recovery");
assert.equal(scenario().audioStalled, true);
assert.equal(scenario({ sending: false }).videoStalled, false, "A static screen must not trigger recovery");
assert.equal(scenario({ sending: false }).audioStalled, false, "Silence must not trigger recovery");
assert.equal(scenario({ video: false, audio: false }).audioStalled, false, "Intentional mute must not trigger recovery");
assert.equal(scenario({ sending: false, decodeBytes: true }).videoStalled, true, "Packets without decoded frames indicate decoder trouble");
const recovered = updateProgress(scenario(), { ...sample, videoFrames: 11, audioBytes: 220 }, { video: true, audio: true, source: sender }, 30000);
assert.equal(recovered.videoStalled, false);
assert.equal(recovered.audioStalled, false);
const expired = updateProgress(scenario(), sample, { video: true, audio: true, source: null }, 30000);
assert.equal(expired.videoStalled, false, "Stale sender evidence must expire");
const repeated = scenario();
assert.equal(updateProgress(repeated, sample, { video: true, audio: true, source: repeated.source }, 40000).videoStalled, false,
  "Re-reading the same report must not extend evidence of sending");
const reset = updateProgress(scenario(), { ...sample, videoFrames: 0, videoId: "replacement" }, { video: true, source: sender }, 30000);
assert.equal(reset.videoStalled, false, "Replacing a stream resets its baseline");

const report = sanitizeReport({ serial: 1, cpuLimited: true, links: { guest: { connected: true, rtt: 20 } },
  stage: { guest: { connected: true, videoFrames: 10, audioBytes: 400 }, outsider: { connected: true } } }, new Set(["guest"]).values());
assert.equal(report.links.guest.rtt, 20);
assert.equal(report.stage.guest.audioBytes, 400);
assert.equal(report.stage.outsider, undefined);
assert.equal(sanitizeReport({ serial: Infinity }, []), null);
assert.equal(sanitizeReport({ serial: 1, links: { guest: { rtt: -1, audioBytes: NaN } } }, ["guest"]).links.guest.rtt, null);

const stats = new Map([
  ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
  ["pair", { currentRoundTripTime: 0.02 }],
  ["v", { id: "v", type: "inbound-rtp", kind: "video", framesDecoded: 12, bytesReceived: 100 }],
  ["a", { id: "a", type: "outbound-rtp", kind: "audio", bytesSent: 200 }],
]);
assert.equal(summarizeStats(stats).rtt, 20);
assert.equal(summarizeStats(stats).videoFrames, 12);
assert.equal(summarizeStats(stats).sentAudioBytes, 200);
console.log("connection health tests passed");
