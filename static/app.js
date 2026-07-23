"use strict";

const elements = {
  lobby: document.querySelector("#lobby"),
  room: document.querySelector("#room"),
  form: document.querySelector("#lobby-form"),
  name: document.querySelector("#display-name"),
  code: document.querySelector("#room-code"),
  create: document.querySelector("#create-room"),
  join: document.querySelector("#join-room"),
  error: document.querySelector("#lobby-error"),
  codeLabel: document.querySelector("#room-code-label"),
  copy: document.querySelector("#copy-code"),
  network: document.querySelector("#network-state"),
  stageVideo: document.querySelector("#stage-video"),
  stageEmpty: document.querySelector("#stage-empty"),
  stageStatus: document.querySelector("#stage-status"),
  stageSubstatus: document.querySelector("#stage-substatus"),
  liveBadge: document.querySelector("#live-badge"),
  fullscreen: document.querySelector("#fullscreen"),
  participantList: document.querySelector("#participant-list"),
  memberCount: document.querySelector("#member-count"),
  voiceStatus: document.querySelector("#voice-status"),
  role: document.querySelector("#role-label"),
  selfName: document.querySelector("#self-name"),
  share: document.querySelector("#share-button"),
  qualityControl: document.querySelector("#quality-control"),
  qualitySelect: document.querySelector("#quality-select"),
  mic: document.querySelector("#mic-button"),
  sound: document.querySelector("#sound-button"),
  leave: document.querySelector("#leave-button"),
  mediaNote: document.querySelector("#media-note-text"),
  remoteAudio: document.querySelector("#remote-audio"),
  toast: document.querySelector("#toast"),
};

const state = {
  roomCode: "",
  clientId: "",
  sessionToken: "",
  hostId: "",
  isHost: false,
  name: "",
  sequence: 0,
  running: false,
  microphone: null,
  microphoneMuted: false,
  display: null,
  displaySurface: "",
  sharedSoundEnabled: true,
  participants: new Map(),
  memberStates: new Map(),
  voicePeers: new Map(),
  stagePeers: new Map(),
  stageQualities: new Map(),
  preferredQuality: "auto",
  iceServers: [],
  iceRefreshSeconds: 0,
};

const QUALITY_PROFILES = {
  auto: { height: null, frameRate: null, maxBitrate: null },
  smooth: { height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  clear: { height: 1080, frameRate: 30, maxBitrate: 5_000_000 },
  high: { height: 1080, frameRate: 60, maxBitrate: 10_000_000 },
  ultra: { height: 1440, frameRate: 30, maxBitrate: 12_000_000 },
};

let toastTimer;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

async function request(path, options = {}) {
  const authorization = state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {};
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...authorization, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function acquireMicrophone() {
  if (state.microphone?.active) return state.microphone;
  state.microphone = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.microphone.getAudioTracks().forEach((track) => { track.contentHint = "speech"; });
  return state.microphone;
}

function setLobbyBusy(busy) {
  elements.create.disabled = busy;
  elements.join.disabled = busy;
}

async function enterRoom(mode) {
  const name = elements.name.value.trim();
  const code = elements.code.value.trim().toUpperCase();
  elements.error.textContent = "";
  if (!name) {
    elements.error.textContent = "请输入昵称";
    elements.name.focus();
    return;
  }
  if (mode === "join" && code.length !== 6) {
    elements.error.textContent = "请输入 6 位房间码";
    elements.code.focus();
    return;
  }

  setLobbyBusy(true);
  let microphoneDenied = false;
  try {
    await acquireMicrophone();
  } catch (error) {
    microphoneDenied = true;
  }

  try {
    const path = mode === "create" ? "/api/rooms" : `/api/rooms/${code}/join`;
    const session = await request(path, { method: "POST", body: JSON.stringify({ name }) });
    startSession(session, name);
    if (microphoneDenied) {
      state.microphoneMuted = true;
      updateMediaControls();
      showToast("未获得麦克风权限，仍可观看直播");
    }
  } catch (error) {
    elements.error.textContent = error.message;
    setLobbyBusy(false);
  }
}

function startSession(session, name) {
  state.roomCode = session.roomCode;
  state.clientId = session.clientId;
  state.sessionToken = session.sessionToken;
  state.hostId = session.hostId;
  state.isHost = session.isHost;
  state.name = name;
  state.sequence = session.sequence;
  state.iceServers = Array.isArray(session.iceServers) ? session.iceServers : [];
  state.iceRefreshSeconds = Number(session.iceRefreshSeconds) || 0;
  state.running = true;
  state.participants.clear();
  session.participants.forEach((participant) => state.participants.set(participant.id, participant));
  state.memberStates.set(state.clientId, { muted: state.microphoneMuted });

  elements.lobby.hidden = true;
  elements.room.hidden = false;
  elements.codeLabel.textContent = state.roomCode;
  elements.selfName.textContent = name;
  elements.role.textContent = state.isHost ? "房主" : "参与者";
  elements.share.hidden = !state.isHost;
  elements.qualityControl.hidden = state.isHost;
  elements.qualitySelect.value = state.preferredQuality;
  elements.stageStatus.textContent = state.isHost ? "开始共享你的屏幕" : "等待房主开始共享";
  elements.stageSubstatus.textContent = state.isHost ? "系统声音可随画面共享" : "语音频道已就绪";
  history.replaceState(null, "", `?room=${state.roomCode}`);
  renderParticipants();
  updateMediaControls();
  setNetworkState(true);
  pollEvents();
  scheduleIceRefresh();
  broadcastMemberState();
}

function scheduleIceRefresh(delaySeconds = state.iceRefreshSeconds) {
  if (!state.running || !state.iceRefreshSeconds) return;
  setTimeout(async () => {
    if (!state.running) return;
    let nextDelay = state.iceRefreshSeconds;
    try {
      const config = await request(`/api/rooms/${state.roomCode}/ice?clientId=${encodeURIComponent(state.clientId)}`);
      state.iceServers = Array.isArray(config.iceServers) ? config.iceServers : state.iceServers;
      state.iceRefreshSeconds = Number(config.iceRefreshSeconds) || state.iceRefreshSeconds;
      for (const peer of [...state.voicePeers.values(), ...state.stagePeers.values()]) {
        peer.pc.setConfiguration({ iceServers: state.iceServers });
      }
    } catch (error) {
      console.warn("Unable to refresh ICE configuration", error);
      nextDelay = Math.min(60, state.iceRefreshSeconds);
    } finally {
      scheduleIceRefresh(nextDelay);
    }
  }, delaySeconds * 1000);
}

function renderParticipants() {
  const ordered = [...state.participants.values()].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  elements.participantList.replaceChildren(...ordered.map((participant) => {
    const member = document.createElement("div");
    const memberState = state.memberStates.get(participant.id);
    const muted = memberState?.muted ?? false;
    member.className = `participant${muted ? " muted" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = [...participant.name][0]?.toUpperCase() || "?";
    const name = document.createElement("div");
    name.className = "participant-name";
    name.textContent = participant.name + (participant.id === state.clientId ? "（你）" : "");
    const role = document.createElement("small");
    role.textContent = participant.isHost ? "房主" : (muted ? "已静音" : "通话中");
    name.append(role);
    const mic = document.createElement("span");
    mic.className = "participant-mic";
    mic.title = muted ? "麦克风已静音" : "麦克风已开启";
    mic.append(document.createElement("span"));
    member.append(avatar, name, mic);
    return member;
  }));
  elements.memberCount.textContent = String(ordered.length);
}

function setNetworkState(online) {
  elements.network.classList.toggle("online", online);
  elements.network.lastChild.textContent = online ? " 已连接" : " 正在重连";
}

function updateMediaControls() {
  const hostHasSilentShare = state.isHost && state.display && !state.display.getAudioTracks().length;
  elements.mic.classList.toggle("off", state.microphoneMuted || !state.microphone);
  elements.mic.querySelector(".control-label").textContent = state.microphoneMuted || !state.microphone ? "麦克风关闭" : "麦克风";
  elements.sound.classList.toggle("off", !state.sharedSoundEnabled);
  elements.sound.disabled = Boolean(hostHasSilentShare);
  elements.sound.querySelector(".control-label").textContent = hostHasSilentShare
    ? "仅共享画面"
    : (state.sharedSoundEnabled ? "共享声音" : "声音关闭");
  elements.share.classList.toggle("active", Boolean(state.display));
  elements.share.querySelector(".control-label").textContent = state.display ? "停止共享" : "共享屏幕";
  elements.mediaNote.textContent = state.isHost && state.display
    ? (state.display.getAudioTracks().length
      ? "标签页音频 · 回音安全"
      : (state.displaySurface === "browser" ? "标签页 · 未共享声音" : "窗口或全屏 · 仅共享画面"))
    : "麦克风仅用于通话";
}

async function sendSignal(peerId, data) {
  if (!state.running) return;
  try {
    await request(`/api/rooms/${state.roomCode}/signal`, {
      method: "POST",
      body: JSON.stringify({ clientId: state.clientId, to: peerId, data }),
    });
  } catch (error) {
    if (state.participants.has(peerId)) console.warn("Signal failed", error);
  }
}

function buildPeer(channel, peerId) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const peer = { pc, candidates: [] };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { channel, candidate });
  };
  pc.onconnectionstatechange = () => {
    const connected = [...state.voicePeers.values()].some((item) => item.pc.connectionState === "connected");
    elements.voiceStatus.textContent = state.participants.size === 1 || connected ? "语音已连接" : "语音连接中";
    if (["failed", "closed"].includes(pc.connectionState) && channel === "voice") removeRemoteAudio(peerId);
  };
  return peer;
}

function createVoicePeer(peerId) {
  let peer = state.voicePeers.get(peerId);
  if (peer) return peer;
  peer = buildPeer("voice", peerId);
  state.voicePeers.set(peerId, peer);
  if (state.microphone) {
    state.microphone.getAudioTracks().forEach((track) => peer.pc.addTrack(track, state.microphone));
  } else {
    peer.pc.addTransceiver("audio", { direction: "recvonly" });
  }
  peer.pc.ontrack = (event) => {
    let audio = document.querySelector(`#voice-${CSS.escape(peerId)}`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = `voice-${peerId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      elements.remoteAudio.append(audio);
    }
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    audio.play().catch(() => showToast("点击页面后可播放通话声音"));
  };
  return peer;
}

async function offerVoice(peerId) {
  const peer = createVoicePeer(peerId);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  await sendSignal(peerId, { channel: "voice", description: peer.pc.localDescription });
  await sendSignal(peerId, { channel: "member-state", muted: state.microphoneMuted });
}

function requestStageQuality() {
  if (!state.isHost && state.hostId) {
    sendSignal(state.hostId, { channel: "stage-quality", quality: state.preferredQuality });
  }
}

async function updateDisplayFrameRate() {
  const track = state.display?.getVideoTracks()[0];
  if (!track) return;
  const needsHighFrameRate = [...state.stageQualities.values()].some((quality) => quality === "high");
  const frameRate = needsHighFrameRate ? 60 : 30;
  track.contentHint = needsHighFrameRate ? "motion" : "detail";
  try {
    await track.applyConstraints({ frameRate: { ideal: frameRate, max: frameRate } });
  } catch (error) {
    console.warn(`Unable to capture at ${frameRate} FPS`, error);
  }
}

async function applyStageQuality(peerId, requestedQuality) {
  const quality = Object.hasOwn(QUALITY_PROFILES, requestedQuality) ? requestedQuality : "auto";
  const profile = QUALITY_PROFILES[quality];
  state.stageQualities.set(peerId, quality);
  await updateDisplayFrameRate();

  const peer = state.stagePeers.get(peerId);
  const sender = peer?.pc.getSenders().find((item) => item.track?.kind === "video");
  if (!sender) return;
  const parameters = sender.getParameters();
  const encoding = parameters.encodings?.[0];
  if (!encoding) return;
  const sourceHeight = sender.track.getSettings().height || profile.height || 1080;
  encoding.scaleResolutionDownBy = profile.height ? Math.max(1, sourceHeight / profile.height) : 1;
  if (profile.maxBitrate) encoding.maxBitrate = profile.maxBitrate;
  else delete encoding.maxBitrate;
  if (profile.frameRate) encoding.maxFramerate = profile.frameRate;
  else delete encoding.maxFramerate;
  parameters.degradationPreference = quality === "high" ? "maintain-framerate" : "maintain-resolution";
  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn(`Unable to apply ${quality} quality for peer`, error);
  }
}

function createStagePeer(peerId) {
  const old = state.stagePeers.get(peerId);
  if (old) old.pc.close();
  const peer = buildPeer("stage", peerId);
  state.stagePeers.set(peerId, peer);
  if (state.isHost && state.display) {
    state.display.getTracks().forEach((track) => peer.pc.addTrack(track, state.display));
  }
  peer.pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    if (elements.stageVideo.srcObject !== stream) elements.stageVideo.srcObject = stream;
    showStage(true);
    elements.stageVideo.play().catch(() => {
      elements.stageVideo.muted = true;
      state.sharedSoundEnabled = false;
      updateMediaControls();
      showToast("点击“共享声音”开启直播声音");
    });
  };
  return peer;
}

async function configureStageAudioSender(peer) {
  const sender = peer?.pc.getSenders().find((item) => item.track?.kind === "audio");
  if (!sender) return;
  sender.track.contentHint = "music";
  const parameters = sender.getParameters();
  const encoding = parameters.encodings?.[0];
  if (!encoding) return;
  encoding.maxBitrate = SyncastMedia.SYSTEM_AUDIO_BITRATE;
  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("Unable to apply system audio bitrate", error);
  }
}

async function offerStage(peerId) {
  if (!state.display) return;
  const peer = createStagePeer(peerId);
  const offer = SyncastMedia.enhanceSystemAudio(await peer.pc.createOffer());
  await peer.pc.setLocalDescription(offer);
  await sendSignal(peerId, { channel: "stage", description: peer.pc.localDescription });
}

async function applyDescription(channel, peerId, description) {
  const peer = channel === "voice" ? createVoicePeer(peerId) : (state.stagePeers.get(peerId) || createStagePeer(peerId));
  const remoteDescription = channel === "stage" ? SyncastMedia.enhanceSystemAudio(description) : description;
  await peer.pc.setRemoteDescription(remoteDescription);
  if (channel === "stage" && description.type === "answer" && state.isHost) {
    await configureStageAudioSender(peer);
  }
  for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  if (description.type === "offer") {
    const createdAnswer = await peer.pc.createAnswer();
    const answer = channel === "stage" ? SyncastMedia.enhanceSystemAudio(createdAnswer) : createdAnswer;
    await peer.pc.setLocalDescription(answer);
    await sendSignal(peerId, { channel, description: peer.pc.localDescription });
    if (channel === "stage" && !state.isHost) requestStageQuality();
  }
}

async function applyCandidate(channel, peerId, candidate) {
  const collection = channel === "voice" ? state.voicePeers : state.stagePeers;
  let peer = collection.get(peerId);
  if (!peer) peer = channel === "voice" ? createVoicePeer(peerId) : createStagePeer(peerId);
  if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
  else peer.candidates.push(candidate);
}

async function handleSignal(payload) {
  const peerId = payload.from;
  const data = payload.data || {};
  if (data.channel === "member-state") {
    state.memberStates.set(peerId, { muted: Boolean(data.muted) });
    renderParticipants();
    return;
  }
  if (data.channel === "stage-stop") {
    closeStagePeer(peerId);
    if (!state.isHost) showStage(false);
    return;
  }
  if (data.channel === "stage-quality") {
    if (state.isHost) await applyStageQuality(peerId, data.quality);
    return;
  }
  if (!['voice', 'stage'].includes(data.channel)) return;
  try {
    if (data.description) await applyDescription(data.channel, peerId, data.description);
    else if (data.candidate) await applyCandidate(data.channel, peerId, data.candidate);
  } catch (error) {
    console.warn(`Unable to apply ${data.channel} signal`, error);
  }
}

async function handleEvent(event) {
  const payload = event.payload;
  if (event.type === "participant-joined") {
    if (payload.id === state.clientId) return;
    state.participants.set(payload.id, payload);
    renderParticipants();
    await offerVoice(payload.id);
    if (state.isHost && state.display) await offerStage(payload.id);
    return;
  }
  if (event.type === "participant-left") {
    state.participants.delete(payload.id);
    state.memberStates.delete(payload.id);
    state.stageQualities.delete(payload.id);
    closePeer(state.voicePeers, payload.id);
    closeStagePeer(payload.id);
    if (state.isHost) updateDisplayFrameRate();
    removeRemoteAudio(payload.id);
    renderParticipants();
    return;
  }
  if (event.type === "signal") await handleSignal(payload);
  if (event.type === "room-closed") closeRoom("房主已结束房间");
}

async function pollEvents() {
  let retryDelay = 700;
  while (state.running) {
    try {
      const result = await request(`/api/rooms/${state.roomCode}/events?clientId=${encodeURIComponent(state.clientId)}&since=${state.sequence}`);
      setNetworkState(true);
      retryDelay = 700;
      for (const event of result.events) {
        state.sequence = Math.max(state.sequence, event.sequence);
        await handleEvent(event);
      }
      state.sequence = Math.max(state.sequence, result.sequence);
    } catch (error) {
      if (!state.running) return;
      if (/失效|结束/.test(error.message)) {
        closeRoom(error.message);
        return;
      }
      setNetworkState(false);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(5000, retryDelay * 1.6);
    }
  }
}

function broadcastMemberState() {
  state.memberStates.set(state.clientId, { muted: state.microphoneMuted });
  renderParticipants();
  for (const participant of state.participants.values()) {
    if (participant.id !== state.clientId) {
      sendSignal(participant.id, { channel: "member-state", muted: state.microphoneMuted });
    }
  }
}

async function startSharing() {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: {
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48_000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "exclude",
    });
    state.display = display;
    const displayTrack = display.getVideoTracks()[0];
    state.displaySurface = displayTrack.getSettings().displaySurface || "unknown";
    state.sharedSoundEnabled = true;
    displayTrack.contentHint = "detail";
    const captureHandle = displayTrack.getCaptureHandle?.();
    const capturedSyncast = captureHandle?.handle === "syncast-voice-room";
    const tabAudioSafe = SyncastMedia.isTabAudioSafe(state.displaySurface) && !capturedSyncast;
    if (!tabAudioSafe) {
      for (const track of display.getAudioTracks()) {
        track.stop();
        display.removeTrack(track);
      }
    }
    for (const track of display.getAudioTracks()) {
      track.contentHint = "music";
      track.applyConstraints({
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48_000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }).catch((error) => console.warn("Unable to apply system audio constraints", error));
    }
    elements.stageVideo.srcObject = display;
    elements.stageVideo.muted = true;
    display.getVideoTracks()[0].addEventListener("ended", stopSharing, { once: true });
    showStage(true);
    updateMediaControls();
    if (capturedSyncast) {
      showToast("不能共享 Syncast 自身声音，请选择其他标签页");
    } else if (!tabAudioSafe) {
      showToast("为避免通话回音，窗口和全屏模式仅共享画面");
    } else if (!display.getAudioTracks().length) {
      showToast("当前标签页没有共享声音，请在选择器中勾选标签页音频");
    }
    await Promise.all([...state.participants.keys()].filter((id) => id !== state.clientId).map(offerStage));
  } catch (error) {
    if (error.name !== "NotAllowedError") showToast("无法开始屏幕共享");
  }
}

function stopSharing() {
  if (!state.display) return;
  const display = state.display;
  state.display = null;
  state.displaySurface = "";
  display.getTracks().forEach((track) => track.stop());
  for (const participant of state.participants.values()) {
    if (participant.id !== state.clientId) sendSignal(participant.id, { channel: "stage-stop" });
  }
  for (const peerId of [...state.stagePeers.keys()]) closeStagePeer(peerId);
  state.stageQualities.clear();
  elements.stageVideo.srcObject = null;
  showStage(false);
  updateMediaControls();
}

function showStage(showing) {
  elements.stageEmpty.hidden = showing;
  elements.liveBadge.hidden = !showing;
  elements.fullscreen.hidden = !showing;
  if (!showing) {
    elements.stageVideo.srcObject = null;
    elements.stageVideo.muted = false;
  }
}

function closePeer(collection, peerId) {
  const peer = collection.get(peerId);
  if (peer) peer.pc.close();
  collection.delete(peerId);
}

function closeStagePeer(peerId) { closePeer(state.stagePeers, peerId); }

function removeRemoteAudio(peerId) {
  document.querySelector(`#voice-${CSS.escape(peerId)}`)?.remove();
}

async function toggleMicrophone() {
  if (!state.microphone?.active) {
    try {
      await acquireMicrophone();
      state.microphoneMuted = false;
      const track = state.microphone.getAudioTracks()[0];
      for (const [peerId, peer] of state.voicePeers) {
        const transceiver = peer.pc.getTransceivers().find((item) => item.receiver.track.kind === "audio");
        if (transceiver) {
          await transceiver.sender.replaceTrack(track);
          transceiver.direction = "sendrecv";
          await offerVoice(peerId);
        }
      }
    } catch (error) {
      showToast("没有获得麦克风权限");
      return;
    }
  } else {
    state.microphoneMuted = !state.microphoneMuted;
    state.microphone.getAudioTracks().forEach((track) => { track.enabled = !state.microphoneMuted; });
  }
  updateMediaControls();
  broadcastMemberState();
}

function toggleSharedSound() {
  state.sharedSoundEnabled = !state.sharedSoundEnabled;
  if (state.isHost && state.display) {
    state.display.getAudioTracks().forEach((track) => { track.enabled = state.sharedSoundEnabled; });
  } else {
    elements.stageVideo.muted = !state.sharedSoundEnabled;
    if (state.sharedSoundEnabled) elements.stageVideo.play().catch(() => showToast("浏览器阻止了声音播放"));
  }
  updateMediaControls();
}

function closeRoom(message) {
  if (!state.running) return;
  state.running = false;
  state.display?.getTracks().forEach((track) => track.stop());
  state.microphone?.getTracks().forEach((track) => track.stop());
  for (const peer of state.voicePeers.values()) peer.pc.close();
  for (const peer of state.stagePeers.values()) peer.pc.close();
  showToast(message);
  setTimeout(() => { window.location.href = window.location.pathname; }, 1200);
}

function leaveRoom() {
  if (!state.running) return;
  fetch(`/api/rooms/${state.roomCode}?clientId=${encodeURIComponent(state.clientId)}`, {
    method: "DELETE",
    keepalive: true,
    headers: { Authorization: `Bearer ${state.sessionToken}` },
  }).catch(() => {});
  closeRoom(state.isHost ? "房间已结束" : "已离开房间");
}

elements.create.addEventListener("click", () => enterRoom("create"));
elements.form.addEventListener("submit", (event) => { event.preventDefault(); enterRoom("join"); });
elements.code.addEventListener("input", () => { elements.code.value = elements.code.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6); });
elements.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  showToast("房间码已复制");
});
elements.share.addEventListener("click", () => state.display ? stopSharing() : startSharing());
elements.qualitySelect.addEventListener("change", () => {
  const quality = elements.qualitySelect.value;
  state.preferredQuality = Object.hasOwn(QUALITY_PROFILES, quality) ? quality : "auto";
  localStorage.setItem("syncast-quality", state.preferredQuality);
  requestStageQuality();
  showToast(`观看画质已设为${elements.qualitySelect.selectedOptions[0].textContent}`);
});
elements.mic.addEventListener("click", toggleMicrophone);
elements.sound.addEventListener("click", toggleSharedSound);
elements.leave.addEventListener("click", leaveRoom);
elements.fullscreen.addEventListener("click", () => elements.stageVideo.requestFullscreen?.());
window.addEventListener("beforeunload", () => {
  if (state.running) fetch(`/api/rooms/${state.roomCode}?clientId=${encodeURIComponent(state.clientId)}`, {
    method: "DELETE",
    keepalive: true,
    headers: { Authorization: `Bearer ${state.sessionToken}` },
  });
});

const initialCode = new URLSearchParams(location.search).get("room");
if (initialCode) elements.code.value = initialCode.toUpperCase().slice(0, 6);
const savedQuality = localStorage.getItem("syncast-quality");
if (Object.hasOwn(QUALITY_PROFILES, savedQuality)) state.preferredQuality = savedQuality;
elements.name.value = localStorage.getItem("lan-live-name") || "";
elements.name.addEventListener("change", () => localStorage.setItem("lan-live-name", elements.name.value.trim()));

try {
  navigator.mediaDevices.setCaptureHandleConfig?.({
    exposeOrigin: false,
    handle: "syncast-voice-room",
    permittedOrigins: ["*"],
  });
} catch (error) {
  console.warn("Unable to register capture handle", error);
}
