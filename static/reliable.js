"use strict";

const RELIABLE_MIME = "video/webm;codecs=vp8,opus";

class ReliableBroadcast {
  constructor(isHost) {
    this.isHost = isHost;
    this.closed = false;
    this.controller = new AbortController();
    this.bytes = 0;
    this.frames = 0;
    this.status = "connecting";
    this.serial = 0;
    this.queue = [];
    this.uploading = 0;
  }

  async publish(source, profile, maxMbps) {
    if (this.source === source && this.profile === profile && this.maxMbps === maxMbps) return;
    this.serial++;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.capture?.getTracks().forEach((track) => track.stop());
    this.source = source;
    this.profile = profile;
    this.maxMbps = maxMbps;
    if (!source?.active) return;
    if (!window.MediaRecorder?.isTypeSupported(RELIABLE_MIME)) throw new Error("可靠广播需要支持 WebM 的浏览器，请使用 Chrome 或选择 WebRTC");
    const serial = this.serial;
    const tracks = source.getTracks().map((track) => track.clone());
    this.capture = new MediaStream(tracks);
    const video = this.capture.getVideoTracks()[0];
    const smooth = profile === "smooth";
    await video.applyConstraints(smooth ? { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }
      : { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
    if (this.closed || serial !== this.serial) return;
    const generation = crypto.randomUUID();
    this.nextSequence = 0;
    this.queue = [];
    const recorder = new MediaRecorder(this.capture, { mimeType: RELIABLE_MIME,
      videoBitsPerSecond: (smooth ? 2 : profile === "balanced" ? 6 : maxMbps) * 1_000_000,
      audioBitsPerSecond: 192_000, videoKeyFrameIntervalDuration: 800 });
    this.recorder = recorder;
    recorder.ondataavailable = ({ data }) => {
      if (!data.size || this.closed || serial !== this.serial) return;
      this.queue.push({ generation, data, serial });
      if (this.queue.reduce((size, item) => size + item.data.size, 0) > 12 * 1024 * 1024) {
        this.fail(new Error("广播上传落后，请降低视频目标或检查房主上行"));
        return;
      }
      this.upload();
    };
    recorder.onerror = () => this.fail(new Error("可靠广播编码失败，请重新共享"));
    recorder.start(200);
    this.status = "connected";
  }

  upload() {
    while (this.uploading < 4 && this.queue.length && !this.closed && this.status !== "failed") {
      const first = this.queue.shift();
      if (first.serial !== this.serial) continue;
      const parts = [first.data];
      let size = first.data.size;
      while (this.queue.length && this.queue[0].serial === first.serial
          && size + this.queue[0].data.size <= 3 * 1024 * 1024) {
        const next = this.queue.shift();
        parts.push(next.data);
        size += next.data.size;
      }
      const item = { ...first, sequence: this.nextSequence++, data: new Blob(parts, { type: RELIABLE_MIME }) };
      this.uploading++;
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(appPath(`/api/rooms/${state.roomCode}/relay?clientId=${encodeURIComponent(state.clientId)}`), {
              method: "POST", body: item.data,
              signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
              headers: { Authorization: `Bearer ${state.sessionToken}`, "Content-Type": RELIABLE_MIME,
                "X-Broadcast-Generation": item.generation, "X-Broadcast-Sequence": String(item.sequence) },
            });
            if (!response.ok) throw new Error((await response.json()).error || "广播上传失败");
            this.bytes += item.data.size;
            return;
          } catch (error) {
            if (this.closed || item.serial !== this.serial) return;
            if (attempt === 2) throw error;
          }
        }
      })().catch((error) => this.fail(error)).finally(() => { this.uploading--; this.upload(); });
    }
  }

  async watch() {
    if (!window.MediaSource?.isTypeSupported(RELIABLE_MIME)) {
      this.fail(new Error("此浏览器不支持可靠广播，请使用 Chrome 或让房主选择 WebRTC"));
      return;
    }
    while (!this.closed) {
      try {
        const response = await fetch(appPath(`/api/rooms/${state.roomCode}/relay?once=1&clientId=${encodeURIComponent(state.clientId)}&generation=${encodeURIComponent(this.generation || "")}&cursor=${this.cursor || 0}`), {
          signal: this.controller.signal, headers: { Authorization: `Bearer ${state.sessionToken}` },
        });
        if (!response.ok) throw new Error("广播接收失败");
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length < 4) throw new Error("广播数据格式无效");
        const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        if (length > 4096 || buffer.length < 4 + length) throw new Error("广播数据格式无效");
        const metadata = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
        if (metadata.bytes < 0 || metadata.bytes > 5 * 1024 * 1024 || buffer.length !== 4 + length + metadata.bytes) throw new Error("广播数据大小无效");
        if (!metadata.bytes) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        if (metadata.reset) await this.resetPlayer(metadata.mime);
        await this.append(buffer.slice(4 + length));
        this.generation = metadata.generation;
        this.cursor = metadata.cursor;
        this.bytes += metadata.bytes;
        this.status = "connected";
        continue;
      } catch (error) {
        if (this.closed) return;
        console.warn("Reliable broadcast receive retry", error);
        this.status = "reconnecting";
      }
      if (!this.closed) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async resetPlayer(mime) {
    if (this.closed || mime !== RELIABLE_MIME) return;
    if (this.url) URL.revokeObjectURL(this.url);
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.url = URL.createObjectURL(mediaSource);
    elements.stageVideo.srcObject = null;
    elements.stageVideo.src = this.url;
    elements.stageVideo.muted = !state.sharedSoundEnabled;
    await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    if (this.closed) return;
    this.buffer = mediaSource.addSourceBuffer(mime);
    const frame = () => {
      if (this.closed || this.mediaSource !== mediaSource) return;
      this.frames++;
      elements.stageVideo.requestVideoFrameCallback?.(frame);
    };
    elements.stageVideo.requestVideoFrameCallback?.(frame);
  }

  async append(payload) {
    const buffer = this.buffer;
    if (this.closed || !buffer) return;
    const update = (operation) => new Promise((resolve, reject) => {
      const done = () => { buffer.removeEventListener("error", failed); resolve(); };
      const failed = () => { buffer.removeEventListener("updateend", done); reject(new Error("广播解码失败")); };
      buffer.addEventListener("updateend", done, { once: true });
      buffer.addEventListener("error", failed, { once: true });
      try { operation(); } catch (error) { failed(); }
    });
    await update(() => buffer.appendBuffer(payload));
    if (this.closed || !buffer.buffered.length) return;
    const video = elements.stageVideo;
    const end = buffer.buffered.end(buffer.buffered.length - 1);
    const start = buffer.buffered.start(buffer.buffered.length - 1);
    if (video.currentTime < start || end - video.currentTime > 2.5) video.currentTime = Math.max(start, end - 1.0);
    if (end - start > 0.8 && video.paused) {
      if (!video.currentTime) video.currentTime = Math.max(start, end - 1.0);
      // play() may wait for more data. Continue feeding the decoder while it
      // waits instead of blocking the stream reader on that same data.
      video.play().catch(() => showToast("点击重新连接播放广播"));
    }
    if (video.currentTime > 5) await update(() => buffer.remove(0, video.currentTime - 3));
    showStage(true);
    renderConnectionStatus();
  }

  sampleStats() {
    const now = performance.now();
    if (this.previous) {
      const seconds = (now - this.previous.time) / 1000;
      this.mbps = (this.bytes - this.previous.bytes) * 8 / seconds / 1_000_000;
      this.fps = (this.frames - this.previous.frames) / seconds;
    }
    this.previous = { time: now, bytes: this.bytes, frames: this.frames };
  }

  setAudioEnabled(enabled) {
    this.capture?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  }

  fail(error) {
    if (this.closed) return;
    if (this.status === "failed") return;
    this.status = "failed";
    this.controller.abort();
    showToast(error.message);
    console.warn("Reliable broadcast failed", error);
    this.recorder?.state === "recording" && this.recorder.stop();
    this.capture?.getTracks().forEach((track) => track.stop());
    renderConnectionStatus();
  }

  close() {
    this.closed = true;
    this.controller.abort();
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.capture?.getTracks().forEach((track) => track.stop());
    if (!this.isHost && elements.stageVideo.src === this.url) {
      elements.stageVideo.removeAttribute("src"); elements.stageVideo.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

function updateReliableBroadcast() {
  if (!state.running || state.stageTransport !== "server" || !state.stageReliable || !state.stageExpected) {
    state.reliableClient?.close(); state.reliableClient = null;
    return;
  }
  if (!state.reliableClient) {
    state.reliableClient = new ReliableBroadcast(state.isHost);
    if (!state.isHost) state.reliableClient.watch();
  }
  if (state.isHost) state.reliableClient.publish(state.display, state.broadcastProfile, state.broadcastBitrate)
    .catch((error) => state.reliableClient?.fail(error));
}
