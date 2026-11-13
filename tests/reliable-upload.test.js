"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");

(async () => {
  const requests = [];
  const timers = new Set();
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const sandbox = { Blob, AbortController, AbortSignal, performance, crypto, MediaRecorder: Recorder,
    MediaSource: { isTypeSupported: () => true }, MediaStream: class { constructor(tracks) { this.tracks = tracks; }
      getTracks() { return this.tracks; } getVideoTracks() { return this.tracks; } },
    state: { roomCode: "ROOM", clientId: "host", sessionToken: "session" }, appPath: path => path,
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    showToast() {}, renderConnectionStatus() {}, console,
    fetch: async (url, options) => { requests.push(options); return { ok: true }; } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve("../static/reliable.js"), "utf8")
    + "\nglobalThis.client = new ReliableBroadcast(true);", sandbox);
  const track = { clone() { return { ...this }; }, stop() {}, applyConstraints: async () => {} };
  const source = { active: true, getTracks: () => [track], getAudioTracks: () => [] };
  await sandbox.client.publish(source, "quality", 12);
  const original = crypto.randomBytes(7 * 1024 * 1024 + 157);
  sandbox.client.recorder.ondataavailable({ data: new Blob([original]) });
  while (sandbox.client.uploading || sandbox.client.queue.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3, "One oversized recorder blob must become bounded uploads");
  assert.deepEqual(requests.map(r => r.headers["X-Broadcast-Sequence"]), ["0", "1", "2"]);
  assert.ok(requests.every(r => r.body.size <= 3 * 1024 * 1024));
  const uploaded = Buffer.concat(await Promise.all(requests.map(async r => Buffer.from(await r.body.arrayBuffer()))));
  assert.deepEqual(uploaded, original, "Splitting must preserve every encoded byte in order");
  assert.equal(sandbox.client.status, "connected");
  sandbox.client.close();
  assert.equal(timers.size, 0, "Leaving must stop encoder monitoring");
  console.log("reliable oversized upload regression passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
