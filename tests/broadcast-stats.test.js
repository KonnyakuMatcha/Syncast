"use strict";
const assert = require("node:assert/strict");
const { summarize, format } = require("../static/broadcast-stats.js");

const reports = (time, overrides = {}) => new Map([
  ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "selected" }],
  ["selected", { type: "candidate-pair", currentRoundTripTime: 0.032, localCandidateId: "local" }],
  ["unused", { type: "candidate-pair", currentRoundTripTime: 2, nominated: true, state: "succeeded" }],
  ["local", { protocol: "udp" }],
  ["v", { id: "v", type: "inbound-rtp", kind: "video", timestamp: time, ssrc: 12, transportId: "transport",
    bytesReceived: 1000, framesDecoded: 10, frameWidth: 1920, frameHeight: 1080,
    packetsLost: 2, packetsReceived: 98, jitterBufferDelay: 1, jitterBufferEmittedCount: 10,
    freezeCount: 1, ...overrides.video }],
  ["a", { id: "a", type: "inbound-rtp", kind: "audio", timestamp: time, ssrc: 13,
    bytesReceived: 200, packetsLost: 0, packetsReceived: 20,
    jitterBufferDelay: 2, jitterBufferEmittedCount: 100, ...overrides.audio }],
]);
const first = summarize(reports(1000), null, false);
assert.equal(first.videoMbps, null, "Do not invent rates without an interval");
assert.equal(first.videoLoss, null);
assert.equal(first.rttMs, 32, "Use the actual selected route");
assert.equal(first.protocol, "UDP");
const second = summarize(reports(6000, {
  video: { bytesReceived: 5_001_000, framesDecoded: 310, packetsLost: 4, packetsReceived: 196,
    jitterBufferDelay: 31, jitterBufferEmittedCount: 310, freezeCount: 3 },
  audio: { bytesReceived: 120_200, packetsLost: 0, packetsReceived: 270,
    jitterBufferDelay: 7, jitterBufferEmittedCount: 350 },
}), first, false);
assert.equal(second.videoMbps, 8);
assert.equal(second.audioMbps, 0.192);
assert.equal(second.streams[0].fps, 60);
assert.equal(second.videoLoss, 2);
assert.equal(second.audioLoss, 0);
assert.equal(second.videoBufferMs, 100);
assert.equal(second.audioBufferMs, 20);
assert.equal(second.freezes, 2, "Report new freezes, not the lifetime total");
const stalled = summarize(reports(6000), first, false);
assert.equal(stalled.streams[0].fps, 0, "A stopped receive stream should show zero decoded FPS");
assert.match(format(second), /VPS → 本机.*UDP.*32 ms/);
assert.match(format(second), /60 帧/);
assert.match(format(second), /共享声音 192 kbps/);

const switched = summarize(reports(11000, { video: { ssrc: 99, bytesReceived: 1_000_000_000, framesDecoded: 8000 } }), second, false);
assert.equal(switched.videoMbps, null, "A new SSRC must start a new baseline");
assert.equal(switched.streams[0].fps, null);
assert.equal(summarize(reports(12000), second, false).videoMbps, null, "Counter resets are not negative bitrates");
assert.equal(summarize(reports(1000), first, false).videoMbps, null, "Duplicate samples are not a time interval");
const unknown = summarize(new Map(), null, false);
assert.equal(unknown.rttMs, null);
assert.equal(unknown.protocol, null);
assert.doesNotMatch(format(unknown), /0 ms|UDP|TCP|NaN/);
assert.match(format({ ...unknown, protocol: "TCP" }), /7882\/UDP/);

function layer(id, timestamp, bytes, frames, reason = "none") {
  return [id, { id, ssrc: id, timestamp, type: "outbound-rtp", kind: "video",
    bytesSent: bytes, framesEncoded: frames, frameWidth: 1280, frameHeight: 720,
    qualityLimitationReason: reason }];
}
const before = summarize(new Map([layer("low", 1000, 100, 1), layer("high", 1000, 100, 1)]), null, true);
const active = summarize(new Map([layer("low", 6000, 100, 1, "cpu"), layer("high", 6000, 5_000_100, 301)]), before, true);
assert.equal(active.videoMbps, 8);
assert.equal(active.streams.length, 1, "Dynacast pauses should not count as active layers or CPU trouble");
assert.doesNotMatch(format(active), /编码处理受限/);
const busy = summarize(new Map([layer("low", 6000, 1_000_100, 151, "cpu"), layer("high", 6000, 5_000_100, 301)]), before, true);
assert.equal(busy.videoMbps, 9.6, "Upload bitrate is the sum of the active layers");
assert.match(format(busy), /编码处理受限/);
console.log("broadcast statistics tests passed");
