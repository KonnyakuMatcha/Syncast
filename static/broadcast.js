"use strict";

// Loaded only when a room selects server broadcasting. The SDK is served locally.
let livekitSDK;
function loadLivekit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (!livekitSDK) livekitSDK = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = appPath("/vendor/livekit-client-2.23.0.umd.js");
    script.onload = () => resolve(window.LivekitClient);
    script.onerror = () => {
      livekitSDK = null;
      script.remove();
      reject(new Error("广播组件加载失败，请重新连接"));
    };
    document.head.append(script);
  });
  return livekitSDK;
}

class SyncastBroadcast {
  constructor({ hostId, isHost, credentials, onStream, onStatus }) {
    Object.assign(this, { hostId, isHost, credentials, onStream, onStatus });
    this.stream = new MediaStream();
    this.tracks = [];
    this.closed = false;
    this.status = "connecting";
    this.pending = Promise.resolve();
  }

  setStatus(status) {
    if (this.closed) return;
    this.status = status;
    this.onStatus(status);
  }

  connect() {
    if (!this.opening) this.opening = this.open();
    return this.opening;
  }

  async open() {
    const sdk = await loadLivekit();
    if (this.closed) return;
    const credentials = await this.credentials();
    if (this.closed) return;
    const room = new sdk.Room({
      adaptiveStream: false,
      dynacast: false,
      stopLocalTrackOnUnpublish: false,
      disconnectOnPageLeave: true,
    });
    this.room = room;
    room.on(sdk.RoomEvent.ConnectionStateChanged, (status) => this.setStatus(status));
    room.on(sdk.RoomEvent.TrackSubscriptionFailed, () => this.setStatus("failed"));
    room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.closed || this.isHost || participant.identity !== this.hostId) return;
      if (![sdk.Track.Source.ScreenShare, sdk.Track.Source.ScreenShareAudio].includes(publication.source)) return;
      for (const old of this.stream.getTracks().filter((item) => item.kind === track.kind)) this.stream.removeTrack(old);
      this.stream.addTrack(track.mediaStreamTrack);
      this.onStream(this.stream);
    });
    room.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
      if (this.closed) return;
      this.stream.removeTrack(track.mediaStreamTrack);
      this.onStream(this.stream);
    });
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (this.closed) return;
      this.stream = new MediaStream();
      this.onStream(this.stream);
    });
    await room.connect(credentials.url, credentials.token, { autoSubscribe: !this.isHost });
    if (this.closed) await room.disconnect(false);
  }

  setSource(source) {
    // Serializing publication also handles a stop or mode change during connect.
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.connect();
      if (this.closed || this.source === source) return;
      const sdk = window.LivekitClient;
      for (const track of this.tracks) {
        await this.room.localParticipant.unpublishTrack(track, true);
        track.stop();
      }
      this.tracks = [];
      this.source = null;
      if (!source?.active || this.closed) return;
      for (const original of source.getTracks()) {
        if (original.readyState !== "live" || this.closed) continue;
        const track = original.clone();
        this.tracks.push(track);
        if (track.kind === "video") {
          await track.applyConstraints({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
          if (this.closed) return;
        }
        await this.room.localParticipant.publishTrack(track, track.kind === "video" ? {
          source: sdk.Track.Source.ScreenShare,
          videoCodec: "vp8",
          simulcast: false,
          backupCodec: false,
          screenShareEncoding: { maxBitrate: 20_000_000, maxFramerate: 60 },
        } : {
          source: sdk.Track.Source.ScreenShareAudio,
          audioPreset: { maxBitrate: 192_000 },
          forceStereo: true,
          dtx: false,
          red: false,
        });
      }
      if (this.closed) return;
      this.source = source;
      this.setStatus("connected");
    });
    return this.pending;
  }

  setAudioEnabled(enabled) {
    for (const track of this.tracks) if (track.kind === "audio") track.enabled = enabled;
  }

  close() {
    this.closed = true;
    this.tracks.forEach((track) => track.stop());
    this.tracks = [];
    this.room?.disconnect(false).catch(() => {});
  }
}

function closeServerBroadcast() {
  state.broadcastClient?.close();
  state.broadcastClient = null;
}

function updateServerBroadcast() {
  if (!state.running || state.stageTransport !== "server" || !state.stageExpected) {
    closeServerBroadcast();
    if (!state.isHost) {
      state.stageStream = null;
      showStage(false);
    }
    return;
  }
  if (!state.broadcastClient) {
    const client = new SyncastBroadcast({
      hostId: state.hostId,
      isHost: state.isHost,
      credentials: () => request(`/api/rooms/${state.roomCode}/broadcast-token`, {
        method: "POST", body: JSON.stringify({ clientId: state.clientId }),
      }),
      onStatus: () => renderConnectionStatus(),
      onStream: (stream) => {
        if (state.broadcastClient !== client) return;
        state.stageStream = stream;
        const hasVideo = stream.getVideoTracks().some((track) => track.readyState === "live");
        if (hasVideo) {
          elements.stageVideo.srcObject = stream;
          elements.stageVideo.muted = !state.sharedSoundEnabled;
          elements.stageVideo.play().catch(() => showToast("点击重新连接以播放共享声音"));
        }
        showStage(hasVideo);
        renderConnectionStatus();
      },
    });
    state.broadcastClient = client;
  }
  const client = state.broadcastClient;
  const operation = state.isHost ? client.setSource(state.display) : client.connect();
  operation.catch((error) => {
    if (state.broadcastClient !== client || client.closed) return;
    client.setStatus("failed");
    console.warn("Server broadcast failed", error);
    showToast("服务器广播连接失败，请检查服务或点击重新连接");
  });
}

function serverBroadcastStatus() {
  if (!state.stageExpected) return "等待共享";
  const client = state.broadcastClient;
  if (["failed", "disconnected"].includes(client?.status)) return "广播连接失败 · 请重连";
  if (!client || client.status === "connecting") return "正在连接广播服务器";
  if (client.status !== "connected") return "广播重连中";
  if (state.isHost) return client.source ? "服务器广播 · 上传 1 路" : "正在发布画面";
  if (!state.stageStream?.getVideoTracks().length) return "等待广播画面";
  return elements.stageVideo.paused ? "等待播放" : "服务器广播 · 播放中";
}
