"use strict";

const RELIABLE_MIME = "video/webm;codecs=vp8,opus";
const RELIABLE_H264 = "video/mp4;codecs=avc1.4d002a,mp4a.40.2";

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
    this.rebuffering = true;
    this.lastTrim = 0;
    this.presented = 0;
    this.seekCount = 0;
    this.compatibleCodec = false;
    this.encoderFallbacks = 0;
  }

  async publish(source, profile, maxMbps, restart = false) {
    if (this.closed || (!restart && this.source === source && this.profile === profile && this.maxMbps === maxMbps)) return;
    this.serial++;
    clearInterval(this.encoderTimer);
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.capture?.getTracks().forEach((track) => track.stop());
    this.source = source;
    this.profile = profile;
    this.maxMbps = maxMbps;
    if (!source?.active) return;
    const types = (this.compatibleCodec ? [RELIABLE_MIME] : [RELIABLE_H264, RELIABLE_MIME]).map((type) => source.getAudioTracks().length
      ? type : type.replace(",mp4a.40.2", "").replace(",opus", ""));
    const mime = types.find((type) => window.MediaRecorder?.isTypeSupported(type) && window.MediaSource?.isTypeSupported(type));
    if (!mime) throw new Error("此浏览器不支持可靠广播，请使用 Chrome 或选择 WebRTC");
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
    let recorder;
    try {
      recorder = new MediaRecorder(this.capture, { mimeType: mime,
        videoBitsPerSecond: (smooth ? 2 : profile === "balanced" ? 6 : maxMbps) * 1_000_000,
        audioBitsPerSecond: 192_000, videoKeyFrameIntervalDuration: 800 });
    } catch (error) {
      this.recoverEncoder(error, serial, mime);
      return;
    }
    this.recorder = recorder;
    this.mime = recorder.mimeType;
    recorder.ondataavailable = ({ data }) => {
      if (!data.size || this.closed || serial !== this.serial) return;
      this.lastEncodedAt = performance.now();
      // timeslice is a hint: a platform encoder may emit a large blob after
      // suspension or a slow keyframe. Keep every HTTP request within the
      // relay's limit without dropping bytes from the encoded timeline.
      for (let offset = 0; offset < data.size; offset += 3 * 1024 * 1024) {
        this.queue.push({ generation, data: data.slice(offset, offset + 3 * 1024 * 1024, this.mime), serial });
      }
      if (this.queue.reduce((size, item) => size + item.data.size, 0) > 12 * 1024 * 1024) {
        this.fail(new Error("广播上传落后，请降低视频目标或检查房主上行"));
        return;
      }
      this.upload();
    };
    recorder.onerror = () => this.recoverEncoder(new Error("可靠广播编码失败"), serial, mime);
    recorder.onstop = () => this.recoverEncoder(new Error("可靠广播编码意外停止"), serial, mime);
    this.lastEncodedAt = performance.now();
    this.status = "encoding";
    try {
      recorder.start(200);
    } catch (error) {
      this.recoverEncoder(error, serial, mime);
      return;
    }
    // Capability checks do not guarantee a working platform encoder. Some
    // browsers emit an initialization blob and then silently stop producing
    // media while screen preview and voice continue normally.
    this.encoderTimer = setInterval(() => {
      if (performance.now() - this.lastEncodedAt >= 10000) {
        this.recoverEncoder(new Error("广播编码器连续 10 秒未输出媒体"), serial, mime);
      }
    }, 1000);
  }

  recoverEncoder(error, serial, mime) {
    if (this.closed || this.status === "failed" || serial !== this.serial) return;
    if (!mime.startsWith("video/mp4") || this.compatibleCodec) {
      this.fail(new Error(`${error.message}，请重新共享或选择 WebRTC`));
      return;
    }
    this.compatibleCodec = true;
    this.encoderFallbacks++;
    console.warn("Reliable broadcast H.264 encoder failed; retrying VP8", error);
    showToast("当前浏览器 H.264 编码未正常输出，正在切换兼容编码");
    this.publish(this.source, this.profile, this.maxMbps, true).catch((failure) => this.fail(failure));
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
      const item = { ...first, sequence: this.nextSequence++, data: new Blob(parts, { type: this.mime }) };
      this.uploading++;
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(appPath(`/api/rooms/${state.roomCode}/relay?clientId=${encodeURIComponent(state.clientId)}`), {
              method: "POST", body: item.data,
              signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
              headers: { Authorization: `Bearer ${state.sessionToken}`, "Content-Type": item.data.type,
                "X-Broadcast-Generation": item.generation, "X-Broadcast-Sequence": String(item.sequence) },
            });
            if (!response.ok) throw new Error((await response.json()).error || "广播上传失败");
            this.bytes += item.data.size;
            if (!this.closed && item.serial === this.serial) this.status = "connected";
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
    if (!window.MediaSource) {
      this.fail(new Error("此浏览器不支持可靠广播，请使用 Chrome 或让房主选择 WebRTC"));
      return;
    }
    while (!this.closed) {
      let reader;
      try {
        const response = await fetch(appPath(`/api/rooms/${state.roomCode}/relay?stream=1&clientId=${encodeURIComponent(state.clientId)}&generation=${encodeURIComponent(this.generation || "")}&cursor=${this.cursor || 0}`), {
          signal: this.controller.signal, headers: { Authorization: `Bearer ${state.sessionToken}` },
        });
        if (!response.ok) throw new Error("广播接收失败");
        reader = response.body.getReader();
        let buffer = new Uint8Array();
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          const combined = new Uint8Array(buffer.length + value.length);
          combined.set(buffer); combined.set(value, buffer.length); buffer = combined;
          while (buffer.length >= 4) {
            const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
            if (length > 4096) throw new Error("广播数据格式无效");
            if (buffer.length < 4 + length) break;
            const metadata = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
            if (!Number.isInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > 5 * 1024 * 1024) throw new Error("广播数据大小无效");
            if (buffer.length < 4 + length + metadata.bytes) break;
            const payload = buffer.slice(4 + length, 4 + length + metadata.bytes);
            buffer = buffer.slice(4 + length + metadata.bytes);
            if (!metadata.bytes) continue;
            if (metadata.reset) await this.resetPlayer(metadata.mime);
            try {
              await this.append(payload);
            } catch (error) {
              // Retrying the same bytes against an errored SourceBuffer never
              // repairs its decoder. Fetch a fresh initialization/keyframe.
              this.generation = "";
              this.cursor = 0;
              throw error;
            }
            this.generation = metadata.generation;
            this.cursor = metadata.cursor;
            this.bytes += metadata.bytes;
            this.status = "connected";
          }
        }
      } catch (error) {
        if (this.closed) return;
        console.warn("Reliable broadcast receive retry", error);
        this.status = "reconnecting";
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (!this.closed) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async resetPlayer(mime) {
    if (this.closed) return;
    if (!MediaSource.isTypeSupported(mime)) throw new Error("此浏览器不支持房主广播编码，请使用 Chrome 或选择 WebRTC");
    if (this.url) URL.revokeObjectURL(this.url);
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.url = URL.createObjectURL(mediaSource);
    this.rebuffering = true;
    this.lastTrim = 0;
    this.presented = 0;
    elements.stageVideo.srcObject = null;
    elements.stageVideo.src = this.url;
    elements.stageVideo.muted = !state.sharedSoundEnabled;
    await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    if (this.closed) return;
    this.buffer = mediaSource.addSourceBuffer(mime);
    const frame = (now, metadata) => {
      if (this.closed || this.mediaSource !== mediaSource) return;
      // A busy main thread may skip callbacks even while the compositor
      // presents frames. Count its actual presentations, not callback calls.
      this.frames += Math.max(0, metadata.presentedFrames - this.presented);
      this.presented = metadata.presentedFrames;
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
    const behind = end - video.currentTime;
    // Frequent seeks discard good video frames and empty the decoder. Keep
    // two seconds for recovery; seek only at startup or a severe backlog.
    if (video.currentTime < start - 0.1 || behind > 8) {
      video.currentTime = Math.max(start, end - 2);
      this.seekCount++;
    }
    if (this.rebuffering && end - Math.max(start, video.currentTime) >= 2) {
      if (!video.currentTime || video.currentTime < start) video.currentTime = Math.max(start, end - 2);
      this.rebuffering = false;
      // play() may wait for more data. Continue feeding the decoder while it
      // waits instead of blocking the stream reader on that same data.
      video.play().catch(() => showToast("点击重新连接播放广播"));
    }
    if (video.currentTime > 10 && video.currentTime - this.lastTrim >= 2) {
      this.lastTrim = video.currentTime;
      await update(() => buffer.remove(0, video.currentTime - 8));
    }
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
    clearInterval(this.encoderTimer);
    this.controller.abort();
    showToast(error.message);
    console.warn("Reliable broadcast failed", error);
    this.recorder?.state === "recording" && this.recorder.stop();
    this.capture?.getTracks().forEach((track) => track.stop());
    renderConnectionStatus();
  }

  close() {
    this.closed = true;
    clearInterval(this.encoderTimer);
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
