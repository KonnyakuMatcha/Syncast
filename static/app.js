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
  sharedSoundEnabled: true,
  participants: new Map(),
  memberStates: new Map(),
  voicePeers: new Map(),
  stagePeers: new Map(),
  iceServers: [],
  iceRefreshSeconds: 0,
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
  elements.mic.classList.toggle("off", state.microphoneMuted || !state.microphone);
  elements.mic.querySelector(".control-label").textContent = state.microphoneMuted || !state.microphone ? "麦克风关闭" : "麦克风";
  elements.sound.classList.toggle("off", !state.sharedSoundEnabled);
  elements.sound.querySelector(".control-label").textContent = state.sharedSoundEnabled ? "共享声音" : "声音关闭";
  elements.share.classList.toggle("active", Boolean(state.display));
  elements.share.querySelector(".control-label").textContent = state.display ? "停止共享" : "共享屏幕";
  elements.mediaNote.textContent = state.isHost && state.display
    ? (state.display.getAudioTracks().length ? "系统声音正在共享" : "当前画面没有共享声音")
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

async function offerStage(peerId) {
  if (!state.display) return;
  const peer = createStagePeer(peerId);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  await sendSignal(peerId, { channel: "stage", description: peer.pc.localDescription });
}

async function applyDescription(channel, peerId, description) {
  const peer = channel === "voice" ? createVoicePeer(peerId) : (state.stagePeers.get(peerId) || createStagePeer(peerId));
  await peer.pc.setRemoteDescription(description);
  for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  if (description.type === "offer") {
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await sendSignal(peerId, { channel, description: peer.pc.localDescription });
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
    closePeer(state.voicePeers, payload.id);
    closeStagePeer(payload.id);
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
      audio: true,
    });
    state.display = display;
    state.sharedSoundEnabled = true;
    elements.stageVideo.srcObject = display;
    elements.stageVideo.muted = true;
    display.getVideoTracks()[0].addEventListener("ended", stopSharing, { once: true });
    showStage(true);
    updateMediaControls();
    if (!display.getAudioTracks().length) showToast("浏览器未提供系统声音，请在共享窗口中勾选声音");
    await Promise.all([...state.participants.keys()].filter((id) => id !== state.clientId).map(offerStage));
  } catch (error) {
    if (error.name !== "NotAllowedError") showToast("无法开始屏幕共享");
  }
}

function stopSharing() {
  if (!state.display) return;
  const display = state.display;
  state.display = null;
  display.getTracks().forEach((track) => track.stop());
  for (const participant of state.participants.values()) {
    if (participant.id !== state.clientId) sendSignal(participant.id, { channel: "stage-stop" });
  }
  for (const peerId of [...state.stagePeers.keys()]) closeStagePeer(peerId);
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
elements.name.value = localStorage.getItem("lan-live-name") || "";
elements.name.addEventListener("change", () => localStorage.setItem("lan-live-name", elements.name.value.trim()));
