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
  constructor({ hostId, isHost, credentials, onStream, onVoice, onStatus }) {
    Object.assign(this, { hostId, isHost, credentials, onStream, onVoice, onStatus });
    this.stream = new MediaStream();
    this.tracks = [];
    this.closed = false;
    this.status = "connecting";
    this.pending = Promise.resolve();
    this.microphonePending = Promise.resolve();
    this.remoteVoices = new Map();
    this.desiredQuality = "1080p60";
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
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
      disconnectOnPageLeave: true,
    });
    this.room = room;
    room.on(sdk.RoomEvent.ConnectionStateChanged, (status) => this.setStatus(status));
    room.on(sdk.RoomEvent.TrackSubscriptionFailed, () => this.setStatus("failed"));
    room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.closed) return;
      if (publication.source === sdk.Track.Source.Microphone) {
        this.remoteVoices.set(participant.identity, track);
        this.onVoice(participant.identity, track);
        return;
      }
      if (this.closed || this.isHost || participant.identity !== this.hostId) return;
      if (![sdk.Track.Source.ScreenShare, sdk.Track.Source.ScreenShareAudio].includes(publication.source)) return;
      // Leave time for NACK/RTX recovery on high-bitrate WAN streams. Voice
      // tracks use their original low-latency buffer and return above.
      const receiver = track.receiver;
      try {
        if (receiver && "jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 500;
        else if (receiver && "playoutDelayHint" in receiver) receiver.playoutDelayHint = 0.5;
      } catch (error) {
        console.warn("Unable to set shared media recovery buffer", error);
      }
      for (const old of this.stream.getTracks().filter((item) => item.kind === track.kind)) this.stream.removeTrack(old);
      this.stream.addTrack(track.mediaStreamTrack);
      this.onStream(this.stream);
      this.applyQuality();
    });
    room.on(sdk.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (this.closed) return;
      if (publication.source === sdk.Track.Source.Microphone) {
        if (this.remoteVoices.get(participant.identity) === track) {
          this.remoteVoices.delete(participant.identity);
          this.onVoice(participant.identity, null);
        }
        return;
      }
      this.stream.removeTrack(track.mediaStreamTrack);
      this.onStream(this.stream);
    });
    for (const event of [sdk.RoomEvent.ParticipantConnected, sdk.RoomEvent.ParticipantDisconnected,
      sdk.RoomEvent.TrackMuted, sdk.RoomEvent.TrackUnmuted]) {
      room.on(event, () => { if (!this.closed) this.onStatus(this.status); });
    }
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (this.closed) return;
      for (const id of this.remoteVoices.keys()) this.onVoice(id, null);
      this.remoteVoices.clear();
      this.stream = new MediaStream();
      this.onStream(this.stream);
    });
    await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
    if (this.closed) await room.disconnect(false);
  }

  setSource(source, profile = "quality", maxMbps = 20) {
    this.desiredSource = source;
    this.desiredProfile = ["smooth", "balanced"].includes(profile) ? profile : "quality";
    this.desiredBitrate = this.desiredProfile === "quality" && [12, 20, 30, 40].includes(maxMbps) ? maxMbps : 20;
    if (!source) this.tracks.forEach((track) => track.stop());
    // Serializing publication also handles a stop or mode change during connect.
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.connect();
      source = this.desiredSource;
      const profile = this.desiredProfile;
      const maxMbps = this.desiredBitrate;
      if (this.closed || (this.source === source && this.profile === profile && this.maxMbps === maxMbps)) return;
      const replaceSource = this.source !== source;
      const sdk = window.LivekitClient;
      for (const track of this.tracks) {
        if (!replaceSource && track.kind === "audio") continue;
        await this.room.localParticipant.unpublishTrack(track, true);
        track.stop();
      }
      this.tracks = replaceSource ? [] : this.tracks.filter((track) => track.kind === "audio");
      this.source = null;
      this.onStatus(this.status);
      if (!source?.active || this.closed) return;
      for (const original of source.getTracks()) {
        if (original.readyState !== "live" || this.closed) continue;
        if (!replaceSource && original.kind === "audio") continue;
        const track = original.clone();
        this.tracks.push(track);
        if (track.kind === "video") {
          track.contentHint = "motion";
          await track.applyConstraints(profile === "smooth"
            ? { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }
            : { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
          if (this.closed) return;
        }
        await this.room.localParticipant.publishTrack(track, track.kind === "video" ? {
          source: sdk.Track.Source.ScreenShare,
          videoCodec: "vp8",
          degradationPreference: "maintain-framerate",
          simulcast: profile !== "smooth",
          backupCodec: false,
          screenShareEncoding: profile === "smooth"
            ? { maxBitrate: 2_000_000, maxFramerate: 30 }
            : { maxBitrate: profile === "quality" ? maxMbps * 1_000_000 : 6_000_000, maxFramerate: 60 },
          screenShareSimulcastLayers: [
            new sdk.VideoPreset({ width: 1280, height: 720,
              maxBitrate: profile === "quality" ? (maxMbps === 12 ? 3_000_000 : 5_000_000) : 2_000_000, maxFramerate: 60 }),
          ],
        } : {
          source: sdk.Track.Source.ScreenShareAudio,
          audioPreset: { maxBitrate: 192_000, priority: "high" },
          forceStereo: true,
          dtx: false,
          red: true,
        });
      }
      if (this.closed) return;
      this.source = source;
      this.profile = profile;
      this.maxMbps = maxMbps;
      this.setStatus("connected");
    });
    return this.pending;
  }

  setQuality(quality) {
    this.desiredQuality = /^(720|1080)p(30|60)$/.test(quality) ? quality : "1080p60";
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.connect();
      this.applyQuality();
    });
    return this.pending;
  }

  applyQuality() {
    if (this.closed || this.isHost || !this.room) return;
    const sdk = window.LivekitClient;
    const publication = this.room.remoteParticipants
      .get(this.hostId)
      ?.getTrackPublication(sdk.Track.Source.ScreenShare);
    if (!publication?.track) return;
    const [, resolutionText, frameRateText] = /^(720|1080)p(30|60)$/.exec(this.desiredQuality) || [];
    const resolution = Number(resolutionText) || 1080;
    const frameRate = Number(frameRateText) || 60;
    const quality = resolution === 720
      ? sdk.VideoQuality.LOW
      : sdk.VideoQuality.HIGH;
    publication.setVideoQuality(quality);
    publication.setVideoFPS?.(frameRate);
  }

  setMicrophone(stream, muted) {
    this.desiredMicrophone = stream?.getAudioTracks().find((track) => track.readyState === "live") || null;
    this.microphoneMuted = muted;
    // Silence immediately, even if publication or an earlier mute is pending.
    if (this.microphoneTrack) this.microphoneTrack.enabled = !muted;
    this.microphonePending = this.microphonePending.catch(() => {}).then(async () => {
      await this.connect();
      if (this.closed) return;
      const original = this.desiredMicrophone;
      if (this.microphoneOriginal !== original) {
        if (this.microphoneTrack) {
          await this.room.localParticipant.unpublishTrack(this.microphoneTrack, true);
          this.microphoneTrack.stop();
        }
        this.microphoneTrack = null;
        this.microphonePublication = null;
        this.microphoneOriginal = null;
        if (this.closed) return;
        if (original?.readyState === "live") {
          const track = original.clone();
          track.enabled = !this.microphoneMuted;
          this.microphoneTrack = track;
          this.microphonePublication = await this.room.localParticipant.publishTrack(track, {
            source: window.LivekitClient.Track.Source.Microphone,
            audioPreset: { maxBitrate: 64_000 },
            forceStereo: false,
            dtx: true,
            stopMicTrackOnMute: false,
          });
          this.microphoneOriginal = original;
        }
      }
      if (this.closed) return;
      const track = this.microphonePublication?.track;
      if (track) {
        if (this.microphoneMuted) await track.mute();
        else await track.unmute();
      }
      this.onStatus(this.status);
    });
    return this.microphonePending;
  }

  setAudioEnabled(enabled) {
    for (const track of this.tracks) if (track.kind === "audio") track.enabled = enabled;
  }

  async sampleMediaStats() {
    if (this.closed || !this.room || this.statsBusy) return;
    this.statsBusy = true;
    try {
      const owner = this.isHost ? this.room.localParticipant : this.room.remoteParticipants.get(this.hostId);
      const video = owner?.getTrackPublication(window.LivekitClient.Track.Source.ScreenShare)?.track;
      const audio = owner?.getTrackPublication(window.LivekitClient.Track.Source.ScreenShareAudio)?.track;
      if (!video) {
        this.mediaStats = null;
        this.statsTrack = null;
        return;
      }
      const reports = await Promise.all([video, audio].map((track) => track?.getRTCStatsReport()));
      if (this.closed || owner?.getTrackPublication(window.LivekitClient.Track.Source.ScreenShare)?.track !== video) return;
      const combined = new Map();
      reports.forEach((stats, index) => {
        const kind = index === 0 ? "video" : "audio";
        for (const [id, report] of stats || []) {
          if (["inbound-rtp", "outbound-rtp"].includes(report.type) && report.kind !== kind) continue;
          combined.set(id, report);
        }
      });
      this.mediaStats = SyncastBroadcastStats.summarize(combined,
        this.statsTrack === video ? this.mediaStats : null, this.isHost);
      this.statsTrack = video;
    } finally {
      this.statsBusy = false;
    }
  }

  close() {
    this.closed = true;
    this.tracks.forEach((track) => track.stop());
    this.tracks = [];
    this.microphoneTrack?.stop();
    for (const id of this.remoteVoices.keys()) this.onVoice(id, null);
    this.remoteVoices.clear();
    this.room?.disconnect(false).catch(() => {});
  }
}

function closeServerBroadcast() {
  state.reliableClient?.close();
  state.reliableClient = null;
  state.broadcastClient?.close();
  state.broadcastClient = null;
}

function updateServerBroadcast() {
  updateReliableBroadcast();
  if (!state.running || state.stageTransport !== "server") {
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
      onVoice: (id, track) => {
        if (state.broadcastClient !== client) return;
        removeRemoteAudio(id);
        if (!track) return;
        const audio = document.createElement("audio");
        audio.id = `voice-${id}`;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = new MediaStream([track.mediaStreamTrack]);
        elements.remoteAudio.append(audio);
        audio.play().catch(() => showToast("点击重新连接以播放通话声音"));
        renderConnectionStatus();
      },
      onStream: (stream) => {
        if (state.broadcastClient !== client || state.isHost || state.stageReliable) return;
        state.stageStream = stream;
        const hasVideo = state.stageExpected && stream.getVideoTracks().some((track) => track.readyState === "live");
        if (hasVideo) {
          // Reassigning the same stream restarts media loading and interrupts
          // both video and shared audio when a member joins or a mic changes.
          if (elements.stageVideo.srcObject !== stream) elements.stageVideo.srcObject = stream;
          elements.stageVideo.muted = !state.sharedSoundEnabled;
          if (elements.stageVideo.paused) {
            elements.stageVideo.play().catch(() => showToast("点击重新连接以播放共享声音"));
          }
        }
        showStage(hasVideo);
        renderConnectionStatus();
      },
    });
    state.broadcastClient = client;
  }
  const client = state.broadcastClient;
  if (!state.isHost) client.onStream(client.stream);
  const operation = Promise.all([
    client.setMicrophone(state.microphone, state.microphoneMuted),
    state.isHost ? client.setSource(state.stageReliable ? null : state.display, state.broadcastProfile, state.broadcastBitrate) : client.connect(),
    state.isHost || state.stageReliable ? null : client.setQuality(viewerQuality()),
  ]);
  operation.catch((error) => {
    if (state.broadcastClient !== client || client.closed) return;
    client.setStatus("failed");
    console.warn("Server broadcast failed", error);
    showToast("服务器广播连接失败，请检查服务或点击重新连接");
  });
}

function serverVoiceProblem(id) {
  const client = state.broadcastClient;
  if (["failed", "disconnected"].includes(client?.status)) return "服务器连接失败";
  if (!client || client.status !== "connected") return "服务器连接中";
  const participant = client.room?.remoteParticipants.get(id);
  if (!participant) return "等待连接服务器";
  // A muted or permission-denied member can still listen to the room.
  if (state.memberStates.get(id)?.muted) return "";
  const publication = participant.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
  if (publication?.isMuted) return "";
  return client.remoteVoices.has(id) ? "" : "等待麦克风";
}

function voiceProblem(id) {
  return state.stageTransport === "server" ? serverVoiceProblem(id) : peerProblem(state.voicePeers.get(id));
}

function applyMediaTransport(config) {
  const version = Number(config.transportVersion);
  if (!Number.isSafeInteger(version) || version < state.transportVersion) return false;
  const changed = version > state.transportVersion;
  state.transportVersion = version;
  if (state.isHost && ["auto", "direct", "relay", "server"].includes(config.topologyMode)
      && (changed || state.topologyMode !== config.topologyMode)) {
    state.topologyMode = config.topologyMode;
    state.topologyEnabled = state.topologyMode === "relay";
    state.autoRelay = { enabled: false, pressureSamples: 0 };
    state.blockedStageEdges.clear();
    localStorage.setItem("syncast-topology-mode", state.topologyMode);
    elements.topologyMode.value = state.topologyMode;
  }
  const transport = config.mediaTransport === "server" ? "server" : "p2p";
  if (state.stageTransport === transport) return changed;
  state.stageTransport = transport;
  for (const id of [...state.voicePeers.keys()]) closePeer(state.voicePeers, id);
  for (const id of [...state.stagePeers.keys()]) closeStagePeer(id);
  elements.remoteAudio.replaceChildren();
  state.stageChildIds.clear();
  state.stageParentId = "";
  state.stageSubscriptions.clear();
  if (transport === "server") {
    if (!state.isHost) showStage(false);
    updateServerBroadcast();
  } else {
    closeServerBroadcast();
    state.stageStream = state.isHost ? state.display : null;
    if (!state.isHost) showStage(false);
    // Each member announces readiness after leaving the server mode. This
    // avoids depending on the ordering of different members' long polls.
    for (const id of state.participants.keys()) {
      if (id !== state.clientId) sendSignal(id, { channel: "voice-ready" });
    }
  }
  renderParticipants();
  updateMediaControls();
  return changed;
}

async function syncRoomState() {
  if (!state.running) return;
  const config = await request(`/api/rooms/${state.roomCode}/state?clientId=${encodeURIComponent(state.clientId)}`);
  if (!state.running || config.transportVersion < state.transportVersion) return;
  applyMediaTransport(config);
  if (state.isHost) await publishStageTopology();
  else if (config.stageTopology) {
    await applyStageTopology({ ...config.stageTopology, ...config.stageTopology.nodes?.[state.clientId] });
  }
}

function serverBroadcastStatus() {
  if (!state.stageExpected) return "等待共享";
  if (state.stageReliable) {
    const reliable = state.reliableClient;
    if (reliable?.status === "failed") return "可靠广播连接失败";
    return reliable?.status === "connected" ? (state.isHost ? "可靠广播 · 上传中" : "可靠广播 · 播放中") : "可靠广播 · 缓冲中";
  }
  const client = state.broadcastClient;
  if (["failed", "disconnected"].includes(client?.status)) return "广播连接失败 · 请重连";
  if (!client || client.status === "connecting") return "正在连接广播服务器";
  if (client.status !== "connected") return "广播重连中";
  if (state.isHost) return client.source ? `服务器广播 · ${client.profile === "smooth" ? "流畅 720p30"
    : client.profile === "balanced" ? "均衡 1080p60" : "高清 1080p60"}` : "正在发布画面";
  if (!state.stageStream?.getVideoTracks().length) return "等待广播画面";
  return elements.stageVideo.paused ? "等待播放" : `服务器广播 · 播放中 · ${formatViewerQuality()}`;
}
