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
  topologyPanel: document.querySelector("#topology-panel"),
  topologyState: document.querySelector("#topology-state"),
  topologyMap: document.querySelector("#topology-map"),
  topologyControl: document.querySelector("#topology-control"),
  topologyMode: document.querySelector("#topology-mode"),
  voiceStatus: document.querySelector("#voice-status"),
  role: document.querySelector("#role-label"),
  selfName: document.querySelector("#self-name"),
  share: document.querySelector("#share-button"),
  windowAudioControl: document.querySelector("#window-audio-control"),
  windowAudioSelect: document.querySelector("#window-audio-select"),
  qualityControl: document.querySelector("#quality-control"),
  qualitySelect: document.querySelector("#quality-select"),
  mic: document.querySelector("#mic-button"),
  sound: document.querySelector("#sound-button"),
  leave: document.querySelector("#leave-button"),
  mediaNote: document.querySelector("#media-note-text"),
  remoteAudio: document.querySelector("#remote-audio"),
  toast: document.querySelector("#toast"),
};

const DEFAULT_QUALITY = "high";
const DEFAULT_WINDOW_AUDIO_MODE = "isolated";
const DEFAULT_TOPOLOGY_ENABLED = false;

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
  windowAudioMode: DEFAULT_WINDOW_AUDIO_MODE,
  participants: new Map(),
  memberStates: new Map(),
  voicePeers: new Map(),
  stagePeers: new Map(),
  stageQualities: new Map(),
  stageStream: null,
  stageParentId: "",
  stageChildIds: new Set(),
  topologyNodes: new Map(),
  topologyEnabled: DEFAULT_TOPOLOGY_ENABLED,
  topologyMode: "auto",
  autoRelay: { enabled: false, pressureSamples: 0 },
  topologyMonitorBusy: false,
  topologyVersion: 0,
  topologyPlanEnabled: false,
  topologyPublishing: Promise.resolve(),
  stageSubscriptions: new Map(),
  blockedStageEdges: new Map(),
  preferredQuality: DEFAULT_QUALITY,
  iceServers: [],
  iceRefreshSeconds: 0,
};

const QUALITY_PROFILES = {
  smooth: { height: 720, frameRate: 30, maxBitrate: 5_000_000 },
  clear: { height: 1080, frameRate: 30, maxBitrate: 10_000_000 },
  high: { height: 1080, frameRate: 60, maxBitrate: 20_000_000 },
  ultra: { height: 1440, frameRate: 30, maxBitrate: 24_000_000 },
};

let toastTimer;
const appBasePath = window.location.pathname.replace(/\/+$/, "");

function appPath(path) {
  return `${appBasePath}${path}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

async function request(path, options = {}) {
  const authorization = state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {};
  const response = await fetch(appPath(path), {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.method ? 8000 : 25000),
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

function canRelayStage() {
  return !(navigator.userAgentData?.mobile
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
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
    const session = await request(path, {
      method: "POST",
      body: JSON.stringify({ name, relayCapable: canRelayStage() }),
    });
    state.microphoneMuted = microphoneDenied;
    startSession(session, name);
    if (microphoneDenied) {
      showToast("未获得麦克风权限，仍可观看直播");
    }
  } catch (error) {
    state.microphone?.getTracks().forEach((track) => track.stop());
    state.microphone = null;
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
  state.stageParentId = state.isHost ? "" : state.hostId;
  state.stageChildIds.clear();
  state.stageSubscriptions.clear();
  state.stageStream = null;
  state.topologyVersion = 0;
  state.topologyNodes.clear();
  state.blockedStageEdges.clear();
  state.participants.clear();
  session.participants.forEach((participant) => state.participants.set(participant.id, participant));
  state.memberStates.set(state.clientId, { muted: state.microphoneMuted });

  elements.lobby.hidden = true;
  elements.room.hidden = false;
  elements.codeLabel.textContent = state.roomCode;
  elements.selfName.textContent = name;
  elements.role.textContent = state.isHost ? "房主" : "参与者";
  elements.topologyControl.hidden = !state.isHost;
  elements.topologyMode.value = state.topologyMode;
  elements.share.hidden = !state.isHost;
  elements.windowAudioControl.hidden = !state.isHost;
  elements.windowAudioSelect.value = state.windowAudioMode;
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
  state.topologyMonitorTimer = setInterval(monitorTopology, 5000);
}

async function monitorTopology() {
  if (!state.running || !state.isHost || state.topologyMode !== "auto" || state.topologyMonitorBusy) return;
  state.topologyMonitorBusy = true;
  const source = state.display;
  try {
    const reports = await Promise.all([...state.stagePeers.values()]
      .filter((peer) => peer.outbound && !peer.retiring)
      .map(async (peer) => [...(await peer.pc.getStats()).values()]));
    if (!state.running || state.topologyMode !== "auto" || source !== state.display) return;
    const limited = reports.filter((stats) => stats.some((report) => report.type === "outbound-rtp"
      && report.kind === "video" && report.framesEncoded > 0
      && ["bandwidth", "cpu"].includes(report.qualityLimitationReason))).length;
    const pressured = limited >= 2 && limited * 2 >= reports.length;
    await applyAutoRelaySample(pressured);
  } catch (error) {
    console.warn("Unable to inspect host upload pressure", error);
  } finally {
    state.topologyMonitorBusy = false;
  }
}

async function applyAutoRelaySample(pressured) {
  if (!state.isHost || state.topologyMode !== "auto") return;
  const canRelay = [...state.participants.values()].some((p) => p.id !== state.hostId && p.relayCapable !== false);
  state.autoRelay = SyncastTopology.updateAutoRelay(state.autoRelay, {
    viewers: state.participants.size - 1,
    pressured: pressured && canRelay,
    sharing: Boolean(state.display),
  });
  if (state.topologyEnabled !== state.autoRelay.enabled) {
    state.topologyEnabled = state.autoRelay.enabled;
    await publishStageTopology();
    showToast(state.topologyEnabled ? "已启用中转，减轻房主上传负担" : "已恢复房主直连");
  }
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
    const isLocalRelay = participant.id === state.clientId
      && state.topologyEnabled
      && state.stageChildIds.size > 0;
    role.textContent = participant.isHost
      ? "房主"
      : (isLocalRelay ? `画面中转 · ${state.stageChildIds.size}` : (muted ? "已静音" : "通话中"));
    name.append(role);
    const mic = document.createElement("span");
    mic.className = "participant-mic";
    mic.title = muted ? "麦克风已静音" : "麦克风已开启";
    mic.append(document.createElement("span"));
    member.append(avatar, name, mic);
    return member;
  }));
  elements.memberCount.textContent = String(ordered.length);
  renderTopology();
}

function topologyNodesForRender() {
  if (state.isHost) {
    return new Map(Object.entries(currentTopologyPlan())
      .map(([id, node]) => [id, { ...node, id }]));
  }
  if (state.topologyNodes.size) return state.topologyNodes;

  const nodes = new Map();
  const rootNode = { id: state.hostId, parentId: "", childIds: [], depth: 0 };
  nodes.set(state.hostId, rootNode);
  for (const participantId of state.participants.keys()) {
    if (participantId === state.hostId) continue;
    nodes.set(participantId, {
      id: participantId,
      parentId: state.hostId,
      childIds: [],
      depth: 1,
    });
    rootNode.childIds.push(participantId);
  }
  return nodes;
}

function topologyNodeElement(node, nodes, level) {
  const participant = state.participants.get(node.id);
  const item = document.createElement("li");
  const childIds = Array.isArray(node.childIds)
    ? node.childIds.filter((childId) => nodes.has(childId))
    : [];
  item.className = [
    "topology-node",
    `depth-${level}`,
    node.id === state.clientId ? "self" : "",
    node.id === state.hostId ? "host" : "",
    childIds.length ? "relay" : "leaf",
  ].filter(Boolean).join(" ");
  item.role = "treeitem";
  item.ariaLevel = String(level + 1);
  item.ariaSelected = node.id === state.clientId ? "true" : "false";
  if (childIds.length) item.ariaExpanded = "true";

  const row = document.createElement("div");
  row.className = "topology-node-row";
  const avatar = document.createElement("span");
  avatar.className = "topology-avatar";
  avatar.textContent = participant?.isHost ? "H" : ([participant?.name][0]?.[0] || "?");
  const name = document.createElement("span");
  name.className = "topology-node-name";
  name.textContent = participant?.name || "已离开成员";
  const tag = document.createElement("span");
  tag.className = "topology-node-tag";
  if (node.id === state.clientId) tag.textContent = "你";
  else if (node.id === state.hostId) tag.textContent = "源";
  else if (childIds.length) tag.textContent = "中转";
  else tag.textContent = "观看";
  row.append(avatar, name, tag);
  item.append(row);

  if (childIds.length) {
    const group = document.createElement("ul");
    group.role = "group";
    group.className = "topology-children";
    for (const childId of childIds) {
      const childNode = nodes.get(childId);
      if (childNode) group.append(topologyNodeElement(childNode, nodes, level + 1));
    }
    item.append(group);
  }
  return item;
}

function renderTopology() {
  const nodes = topologyNodesForRender();
  const rootNode = nodes.get(state.hostId);
  if (!rootNode) return;

  const list = document.createElement("ul");
  list.className = "topology-list";
  list.role = "tree";
  list.ariaLabel = "屏幕转发拓扑";
  list.append(topologyNodeElement(rootNode, nodes, 0));
  elements.topologyMap.replaceChildren(list);
  elements.topologyState.textContent = state.topologyEnabled ? "树状" : "星型";
  elements.topologyState.classList.toggle("tree", state.topologyEnabled);
}

function setNetworkState(online) {
  elements.network.classList.toggle("online", online);
  elements.network.lastChild.textContent = online ? " 已连接" : " 正在重连";
}

function currentTopologyPlan() {
  const memberIds = [...state.participants.keys()];
  const relayIds = memberIds.filter((id) => (
    id === state.hostId || state.participants.get(id)?.relayCapable !== false
  ));
  const blockedEdges = new Map();
  for (const [childId, parents] of state.blockedStageEdges) {
    for (const [parentId, expires] of parents) if (expires <= Date.now()) parents.delete(parentId);
    blockedEdges.set(childId, new Set(parents.keys()));
  }
  return SyncastTopology.planTopology(memberIds, state.hostId, {
    enabled: state.topologyEnabled,
    relayIds,
    blockedEdges,
    previousPlan: state.topologyPlanEnabled === state.topologyEnabled
      ? Object.fromEntries(state.topologyNodes) : {},
  });
}

function publishStageTopology() {
  state.topologyPublishing = state.topologyPublishing
    .catch((error) => console.warn("Unable to publish topology", error))
    .then(publishStageTopologyNow);
  return state.topologyPublishing;
}

async function publishStageTopologyNow() {
  if (!state.isHost || !state.running) return;
  const enabled = state.topologyEnabled;
  const plan = currentTopologyPlan();
  const version = ++state.topologyVersion;
  await applyStageTopology({ version, enabled, nodes: plan, ...plan[state.clientId] });
  await Promise.all([...state.participants.keys()]
    .filter((id) => id !== state.clientId)
    .map((id) => sendSignal(id, {
      channel: "stage-topology",
      version,
      enabled,
      nodes: plan,
      ...plan[id],
    })));
}

async function applyStageTopology(assignment) {
  const version = Number(assignment.version) || 0;
  if (!state.isHost && version <= state.topologyVersion) return;
  state.topologyVersion = version;
  state.topologyEnabled = Boolean(assignment.enabled);
  state.topologyPlanEnabled = state.topologyEnabled;
  const oldParentId = state.stageParentId;
  const nodes = assignment.nodes;
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    state.topologyNodes = new Map(Object.entries(nodes)
      .filter(([id]) => state.participants.has(id))
      .map(([id, node]) => [id, {
        id,
        parentId: id === state.hostId ? "" : String(node.parentId || state.hostId),
        childIds: Array.isArray(node.childIds) ? node.childIds : [],
        depth: Number(node.depth) || 0,
      }]));
  } else if (state.isHost) {
    state.topologyNodes = new Map(Object.entries(currentTopologyPlan())
      .map(([id, node]) => [id, { ...node, id }]));
  }
  const parentId = state.isHost ? "" : String(assignment.parentId || state.hostId);
  const childIds = new Set((assignment.childIds || [])
    .filter((id) => id !== state.clientId && state.participants.has(id)));
  state.stageParentId = parentId;
  state.stageChildIds = childIds;

  for (const [peerId, peer] of [...state.stagePeers]) {
    const shouldBeOutbound = childIds.has(peerId);
    const shouldRemain = peerId === parentId || shouldBeOutbound;
    if (shouldRemain && peer.outbound === shouldBeOutbound) {
      clearTimeout(peer.retireTimer);
      peer.retireTimer = null;
      peer.retiring = false;
    } else if (!shouldRemain && peer.pc.connectionState === "connected") {
      // Keep an old route briefly while the viewer subscribes to its new
      // parent. The viewer explicitly releases it after decoding new media.
      peer.retiring = true;
      if (!peer.retireTimer) peer.retireTimer = setTimeout(() => {
        if (state.stagePeers.get(peerId) === peer && peer.retiring) closeStagePeer(peerId);
      }, 30000);
    } else closeStagePeer(peerId);
  }

  if (!state.isHost && oldParentId !== parentId) {
    // Leave the displayed stream in place until the replacement has frames.
    requestStageQuality();
  }
  if (state.isHost) state.stageStream = state.display;
  elements.topologyMode.value = state.topologyMode;
  renderParticipants();
  updateMediaControls();
  if (!state.isHost && parentId) {
    await sendSignal(parentId, { channel: "stage-subscribe", version });
  }
  await connectStageChildren();
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
  elements.windowAudioSelect.disabled = Boolean(state.display);
  elements.mediaNote.textContent = state.isHost && state.display
    ? (state.display.getAudioTracks().length
      ? (SyncastMedia.isIsolatedAudioSafe(state.displaySurface, state.windowAudioMode)
        ? (state.displaySurface === "window" ? "窗口独立音频" : "标签页音频 · 回音安全")
        : "系统音频 · 可能产生回音")
      : (state.displaySurface === "monitor" ? "整个屏幕 · 仅共享画面" : "当前来源 · 未共享声音"))
    : (state.topologyEnabled && state.stageChildIds.size
      ? `正在向 ${state.stageChildIds.size} 个节点转发画面`
      : "麦克风仅用于通话");
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

async function selectedStageRouteUsesTurn(pc) {
  const stats = await pc.getStats();
  return SyncastTopology.selectedRouteUsesTurn(stats);
}

async function inspectStageRoute(peerId, peer) {
  if (!state.topologyEnabled
      || peerId !== state.stageParentId
      || state.stagePeers.get(peerId) !== peer
      || peer.routeChecked) return;
  try {
    const usesTurn = await selectedStageRouteUsesTurn(peer.pc);
    if (usesTurn === null) {
      peer.routeCheckAttempts += 1;
      if (peer.routeCheckAttempts < 3) setTimeout(() => inspectStageRoute(peerId, peer), 1000);
      return;
    }
    peer.routeChecked = true;
    // Keep route diagnostics separate from recovery; normal playback should
    // not trigger a topology change merely because a stats sample arrived.
    peer.usesTurn = usesTurn;
  } catch (error) {
    console.warn("Unable to inspect stage route", error);
  }
}

function blockStageEdge(childId, parentId) {
  let blockedParents = state.blockedStageEdges.get(childId);
  if (!blockedParents) {
    blockedParents = new Map();
    state.blockedStageEdges.set(childId, blockedParents);
  }
  if (blockedParents.get(parentId) > Date.now()) return false;
  blockedParents.set(parentId, Date.now() + 60000);
  return true;
}

function buildPeer(channel, peerId) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const peer = {
    pc,
    candidates: [],
    routeChecked: false,
    routeCheckScheduled: false,
    routeCheckAttempts: 0,
    recoveryAttempts: 0,
    makingOffer: false,
    ignoreOffer: false,
    lastRestartAt: 0,
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && !SyncastMedia.isRelayCandidate(candidate)) sendSignal(peerId, { channel, candidate });
  };
  const connectionChanged = () => {
    const collection = channel === "voice" ? state.voicePeers : state.stagePeers;
    if (!state.running || collection.get(peerId) !== peer) return;
    const connected = [...state.voicePeers.values()].filter((item) => item.pc.connectionState === "connected").length;
    elements.voiceStatus.textContent = connected >= state.participants.size - 1
      ? "语音已连接" : (connected ? "部分语音连接中" : "语音连接中");
    if (pc.connectionState === "connected" && ["connected", "completed"].includes(pc.iceConnectionState)) {
      clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
      peer.recoveryAttempts = 0;
    } else if (["failed", "disconnected", "connecting"].includes(pc.connectionState)
        || ["failed", "disconnected"].includes(pc.iceConnectionState)) {
      schedulePeerRecovery(channel, peerId, peer,
        pc.connectionState === "failed" || pc.iceConnectionState === "failed" ? 0 : 4000);
    }
    if (pc.connectionState === "connected"
        && channel === "stage"
        && peerId === state.stageParentId
        && !peer.routeCheckScheduled) {
      peer.routeCheckScheduled = true;
      setTimeout(() => inspectStageRoute(peerId, peer), 500);
    }
  };
  pc.onconnectionstatechange = connectionChanged;
  pc.oniceconnectionstatechange = connectionChanged;
  return peer;
}

function ownsPeerOffer(channel, peerId, peer) {
  return channel === "stage" ? peer.outbound : state.clientId < peerId;
}

function schedulePeerRecovery(channel, peerId, peer, delay = 4000) {
  if (!state.running || peer.recoveryTimer || peer.recoveryRunning || peer.retiring) return;
  peer.recoveryTimer = setTimeout(async () => {
    peer.recoveryTimer = null;
    const collection = channel === "voice" ? state.voicePeers : state.stagePeers;
    if (!state.running || collection.get(peerId) !== peer || peer.retiring) return;
    if (peer.pc.connectionState === "connected"
        && ["connected", "completed"].includes(peer.pc.iceConnectionState)) return;
    if (peer.recoveryAttempts >= 3) {
      if (channel === "stage" && state.topologyEnabled && peerId === state.stageParentId) {
        await sendSignal(state.hostId, { channel: "stage-route-failed", parentId: peerId });
      } else showToast(channel === "voice" ? "部分语音连接未恢复，请尝试重新加入" : "画面连接未恢复，请尝试重新加入");
      return;
    }
    peer.recoveryAttempts += 1;
    peer.recoveryRunning = true;
    try {
      if (ownsPeerOffer(channel, peerId, peer)) await restartPeer(channel, peerId, peer);
      else await sendSignal(peerId, { channel: "peer-restart", mediaChannel: channel });
    } catch (error) {
      console.warn("Unable to restart media connection", error);
    } finally {
      peer.recoveryRunning = false;
    }
    schedulePeerRecovery(channel, peerId, peer, 8000);
  }, delay);
}

async function restartPeer(channel, peerId, peer) {
  if (Date.now() - peer.lastRestartAt < 5000 || peer.makingOffer) return;
  if (!["stable", "have-local-offer"].includes(peer.pc.signalingState)) return;
  peer.lastRestartAt = Date.now();
  if (peer.pc.signalingState === "have-local-offer") {
    await sendSignal(peerId, { channel, description: peer.pc.localDescription });
    return;
  }
  peer.routeChecked = false;
  peer.routeCheckScheduled = false;
  peer.routeCheckAttempts = 0;
  await offerPeer(channel, peerId, peer, { iceRestart: true });
}

async function offerPeer(channel, peerId, peer, options = {}) {
  if (peer.pc.signalingState === "closed") return;
  if (peer.makingOffer || peer.pc.signalingState !== "stable") {
    peer.offerPending = true;
    peer.restartPending ||= Boolean(options.iceRestart);
    return;
  }
  options = { ...options, iceRestart: Boolean(options.iceRestart || peer.restartPending) };
  peer.offerPending = false;
  peer.restartPending = false;
  peer.makingOffer = true;
  try {
    const created = await peer.pc.createOffer(options);
    const offer = channel === "stage" ? SyncastMedia.enhanceSystemAudio(created) : created;
    await peer.pc.setLocalDescription(offer);
    await sendSignal(peerId, { channel, description: peer.pc.localDescription });
  } finally {
    peer.makingOffer = false;
    if (peer.offerPending && peer.pc.signalingState === "stable") {
      queueMicrotask(() => offerPeer(channel, peerId, peer)
        .catch((error) => console.warn("Unable to negotiate pending media", error)));
    }
  }
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
  await offerPeer("voice", peerId, peer);
  await sendSignal(peerId, { channel: "member-state", muted: state.microphoneMuted });
}

function requestStageQuality() {
  if (!state.isHost && state.stageParentId) {
    const quality = state.stageChildIds.size ? "high" : state.preferredQuality;
    sendSignal(state.stageParentId, { channel: "stage-quality", quality });
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
  if (!state.stageChildIds.has(peerId)) return;
  const quality = Object.hasOwn(QUALITY_PROFILES, requestedQuality) ? requestedQuality : DEFAULT_QUALITY;
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

function getStageSourceStream() {
  return state.isHost ? state.display : state.stageStream;
}

function hasLiveStageSource() {
  return getStageSourceStream()?.getVideoTracks().some((track) => track.readyState === "live");
}

function createStagePeer(peerId, outbound = false) {
  const old = state.stagePeers.get(peerId);
  if (old?.outbound === outbound) return old;
  if (old) closeStagePeer(peerId);
  const peer = buildPeer("stage", peerId);
  peer.outbound = outbound;
  peer.remoteStream = null;
  state.stagePeers.set(peerId, peer);
  const source = getStageSourceStream();
  if (outbound && source) {
    source.getTracks()
      .filter((track) => track.readyState === "live")
      .forEach((track) => {
        track.contentHint = track.kind === "video" ? "motion" : "music";
        peer.pc.addTrack(track, source);
      });
  }
  peer.pc.ontrack = (event) => {
    if (peer.outbound) return;
    const stream = event.streams[0] || peer.remoteStream || new MediaStream();
    if (!event.streams[0] && !stream.getTracks().includes(event.track)) stream.addTrack(event.track);
    peer.remoteStream = stream;
    activateStageStream(peerId, peer).catch((error) => console.warn("Unable to activate stage", error));
  };
  return peer;
}

async function activateStageStream(peerId, peer) {
  if (peerId !== state.stageParentId || state.stagePeers.get(peerId) !== peer) return;
  const stream = peer.remoteStream;
  if (!stream?.getVideoTracks().length) return;
  if (state.stageStream && state.stageStream !== stream) {
    const stats = [...(await peer.pc.getStats()).values()];
    if (!stats.some((report) => report.type === "inbound-rtp"
        && report.kind === "video" && report.framesDecoded > 0)) {
      if (!peer.activationTimer) peer.activationTimer = setTimeout(() => {
        peer.activationTimer = null;
        activateStageStream(peerId, peer).catch((error) => console.warn("Unable to switch stage", error));
      }, 200);
      return;
    }
  }
  if (peerId !== state.stageParentId || state.stagePeers.get(peerId) !== peer) return;
  state.stageStream = stream;
  if (elements.stageVideo.srcObject !== stream) elements.stageVideo.srcObject = stream;
  elements.stageVideo.muted = !state.sharedSoundEnabled;
  showStage(true);
  elements.stageVideo.play().catch((error) => {
    if (error.name !== "NotAllowedError" || elements.stageVideo.srcObject !== stream) return;
    elements.stageVideo.muted = true;
    state.sharedSoundEnabled = false;
    updateMediaControls();
    showToast("点击“共享声音”开启直播声音");
  });
  for (const [oldId, oldPeer] of [...state.stagePeers]) {
    if (!oldPeer.outbound && oldId !== peerId) {
      sendSignal(oldId, { channel: "stage-release" });
      closeStagePeer(oldId);
    }
  }
  // A relay may retain children while its incoming source changes. Replace
  // their senders' tracks so the retained connections carry the new source.
  for (const [childId, child] of state.stagePeers) {
    if (!child.outbound) continue;
    for (const track of stream.getTracks()) {
      const sender = child.pc.getSenders().find((item) => item.track?.kind === track.kind);
      if (sender && sender.track !== track) await sender.replaceTrack(track);
      else if (!sender) {
        child.pc.addTrack(track, stream);
        await offerStage(childId);
      }
    }
  }
  requestStageQuality();
  await connectStageChildren();
}

async function connectStageChildren() {
  if (!hasLiveStageSource()) return;
  const pending = [...state.stageChildIds]
    .filter((peerId) => state.stageSubscriptions.get(peerId) === state.topologyVersion)
    .filter((peerId) => !state.stagePeers.get(peerId)?.outbound)
    .map(offerStage);
  const results = await Promise.allSettled(pending);
  for (const result of results) {
    if (result.status === "rejected") console.warn("Unable to offer stage to child", result.reason);
  }
  requestStageQuality();
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
  if (!state.stageChildIds.has(peerId) || !hasLiveStageSource()) return;
  const peer = createStagePeer(peerId, true);
  await offerPeer("stage", peerId, peer);
}

async function applyDescription(channel, peerId, description) {
  const peer = channel === "voice"
    ? createVoicePeer(peerId)
    : (state.stagePeers.get(peerId) || createStagePeer(peerId, state.stageChildIds.has(peerId)));
  const p2pDescription = SyncastMedia.stripRelayCandidates(description);
  const remoteDescription = channel === "stage" ? SyncastMedia.enhanceSystemAudio(p2pDescription) : p2pDescription;
  const collision = description.type === "offer"
    && (peer.makingOffer || peer.pc.signalingState !== "stable");
  peer.ignoreOffer = collision && ownsPeerOffer(channel, peerId, peer);
  if (peer.ignoreOffer) return;
  await peer.pc.setRemoteDescription(remoteDescription);
  if (channel === "stage" && description.type === "answer" && peer.outbound) {
    await configureStageAudioSender(peer);
    await applyStageQuality(peerId, state.stageQualities.get(peerId) || DEFAULT_QUALITY);
  }
  for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  if (description.type === "offer") {
    const createdAnswer = await peer.pc.createAnswer();
    const answer = channel === "stage" ? SyncastMedia.enhanceSystemAudio(createdAnswer) : createdAnswer;
    await peer.pc.setLocalDescription(answer);
    await sendSignal(peerId, { channel, description: peer.pc.localDescription });
    if (channel === "stage" && !state.isHost) requestStageQuality();
  }
  if (peer.offerPending) await offerPeer(channel, peerId, peer);
}

async function applyCandidate(channel, peerId, candidate) {
  if (SyncastMedia.isRelayCandidate(candidate)) return;
  const collection = channel === "voice" ? state.voicePeers : state.stagePeers;
  let peer = collection.get(peerId);
  if (!peer) peer = channel === "voice"
    ? createVoicePeer(peerId)
    : createStagePeer(peerId, state.stageChildIds.has(peerId));
  if (peer.ignoreOffer) return;
  if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
  else peer.candidates.push(candidate);
}

async function handleSignal(payload) {
  const peerId = payload.from;
  const data = payload.data || {};
  if (!state.participants.has(peerId)) return;
  if (data.channel === "peer-restart") {
    const channel = data.mediaChannel;
    if (!["voice", "stage"].includes(channel)) return;
    const peer = (channel === "voice" ? state.voicePeers : state.stagePeers).get(peerId);
    if (peer && !peer.retiring && ownsPeerOffer(channel, peerId, peer)) {
      await restartPeer(channel, peerId, peer);
    }
    return;
  }
  if (data.channel === "stage-subscribe") {
    const version = Number(data.version);
    if (version < state.topologyVersion || !Number.isSafeInteger(version)) return;
    state.stageSubscriptions.set(peerId, version);
    await connectStageChildren();
    return;
  }
  if (data.channel === "stage-release") {
    const peer = state.stagePeers.get(peerId);
    if (peer?.outbound && peer.retiring) closeStagePeer(peerId);
    return;
  }
  if (data.channel === "stage-topology") {
    if (peerId === state.hostId) await applyStageTopology(data);
    return;
  }
  if (data.channel === "stage-route-failed") {
    const assignedParentId = state.isHost ? state.topologyNodes.get(peerId)?.parentId : "";
    if (state.isHost
        && state.topologyEnabled
        && data.parentId === assignedParentId
        && blockStageEdge(peerId, data.parentId)) {
      await publishStageTopology();
    }
    return;
  }
  if (data.channel === "member-state") {
    state.memberStates.set(peerId, { muted: Boolean(data.muted) });
    renderParticipants();
    return;
  }
  if (data.channel === "stage-stop") {
    if (peerId === state.hostId) {
      for (const stagePeerId of [...state.stagePeers.keys()]) closeStagePeer(stagePeerId);
      state.stageStream = null;
      if (!state.isHost) showStage(false);
    }
    return;
  }
  if (data.channel === "stage-quality") {
    if (state.stageChildIds.has(peerId)) await applyStageQuality(peerId, data.quality);
    return;
  }
  if (!['voice', 'stage'].includes(data.channel)) return;
  if (data.channel === "stage"
      && peerId !== state.stageParentId
      && !state.stageChildIds.has(peerId)) return;
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
    if (state.isHost) await publishStageTopology();
    return;
  }
  if (event.type === "participant-left") {
    state.participants.delete(payload.id);
    state.memberStates.delete(payload.id);
    state.stageQualities.delete(payload.id);
    state.stageSubscriptions.delete(payload.id);
    state.blockedStageEdges.delete(payload.id);
    state.topologyNodes.delete(payload.id);
    for (const node of state.topologyNodes.values()) {
      node.childIds = node.childIds.filter((childId) => childId !== payload.id);
    }
    for (const blockedParents of state.blockedStageEdges.values()) blockedParents.delete(payload.id);
    closePeer(state.voicePeers, payload.id);
    closeStagePeer(payload.id);
    if (payload.id === state.stageParentId) {
      state.stageStream = null;
      elements.stageVideo.srcObject = null;
      showStage(false);
    }
    if (state.isHost) {
      await updateDisplayFrameRate();
      await publishStageTopology();
    }
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
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: {
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48_000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include",
      windowAudio: SyncastMedia.getWindowAudioPreference(state.windowAudioMode),
    });
    state.display = display;
    state.stageStream = display;
    const displayTrack = display.getVideoTracks()[0];
    state.displaySurface = displayTrack.getSettings().displaySurface || "unknown";
    state.sharedSoundEnabled = true;
    displayTrack.contentHint = "motion";
    const captureHandle = displayTrack.getCaptureHandle?.();
    const capturedSyncast = captureHandle?.handle === "syncast-voice-room";
    if (capturedSyncast) {
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
    } else if (!SyncastMedia.isIsolatedAudioSafe(state.displaySurface, state.windowAudioMode)
        && display.getAudioTracks().length) {
      showToast("系统音频会包含通话声音，可能产生回音");
    } else if (state.displaySurface === "window" && display.getAudioTracks().length) {
      showToast("已共享窗口独立音频");
    } else if (state.displaySurface === "monitor") {
      showToast("当前系统或浏览器没有提供整屏音频，正在仅共享画面");
    } else if (state.displaySurface === "window" && !display.getAudioTracks().length) {
      showToast("当前系统或浏览器没有提供窗口音频，正在仅共享画面");
    } else if (!display.getAudioTracks().length) {
      showToast("当前标签页没有共享声音，请在选择器中勾选标签页音频");
    }
    await publishStageTopology();
  } catch (error) {
    if (error.name !== "NotAllowedError") showToast("无法开始屏幕共享");
  }
}

function stopSharing() {
  if (!state.display) return;
  const display = state.display;
  state.display = null;
  state.autoRelay = { enabled: false, pressureSamples: 0 };
  if (state.topologyMode === "auto") state.topologyEnabled = false;
  state.stageStream = null;
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
  publishStageTopology().catch((error) => console.warn("Unable to reset stage topology", error));
}

function showStage(showing) {
  elements.stageEmpty.hidden = showing;
  elements.liveBadge.hidden = !showing;
  elements.fullscreen.hidden = !showing;
  if (!showing) {
    elements.stageVideo.srcObject = null;
    elements.stageVideo.muted = state.isHost || !state.sharedSoundEnabled;
  }
}

function closePeer(collection, peerId) {
  const peer = collection.get(peerId);
  collection.delete(peerId);
  if (peer) {
    clearTimeout(peer.recoveryTimer);
    clearTimeout(peer.retireTimer);
    clearTimeout(peer.activationTimer);
    peer.pc.close();
  }
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
  clearInterval(state.topologyMonitorTimer);
  state.display?.getTracks().forEach((track) => track.stop());
  state.microphone?.getTracks().forEach((track) => track.stop());
  for (const id of [...state.voicePeers.keys()]) closePeer(state.voicePeers, id);
  for (const id of [...state.stagePeers.keys()]) closeStagePeer(id);
  showToast(message);
  setTimeout(() => { window.location.href = window.location.pathname; }, 1200);
}

function leaveRoom() {
  if (!state.running) return;
  fetch(appPath(`/api/rooms/${state.roomCode}?clientId=${encodeURIComponent(state.clientId)}`), {
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
elements.topologyMode.addEventListener("change", async () => {
  if (!state.isHost) return;
  state.topologyMode = elements.topologyMode.value;
  state.autoRelay = { enabled: false, pressureSamples: 0 };
  state.topologyEnabled = state.topologyMode === "relay";
  state.blockedStageEdges.clear();
  localStorage.setItem("syncast-topology-mode", state.topologyMode);
  await publishStageTopology();
  showToast(state.topologyMode === "auto" ? "将根据房主负载自动选择连接方式"
    : (state.topologyEnabled ? "已开启中转，节省房主上传" : "已恢复房主直连"));
});
elements.windowAudioSelect.addEventListener("change", () => {
  state.windowAudioMode = elements.windowAudioSelect.value === "system" ? "system" : "isolated";
  localStorage.setItem("syncast-window-audio", state.windowAudioMode);
  showToast(state.windowAudioMode === "system" ? "窗口将使用系统混音" : "窗口将使用独立音频");
});
elements.qualitySelect.addEventListener("change", () => {
  const quality = elements.qualitySelect.value;
  state.preferredQuality = Object.hasOwn(QUALITY_PROFILES, quality) ? quality : DEFAULT_QUALITY;
  localStorage.setItem("syncast-quality", state.preferredQuality);
  requestStageQuality();
  showToast(`观看画质已设为${elements.qualitySelect.selectedOptions[0].textContent}`);
});
elements.mic.addEventListener("click", toggleMicrophone);
elements.sound.addEventListener("click", toggleSharedSound);
elements.leave.addEventListener("click", leaveRoom);
elements.fullscreen.addEventListener("click", () => elements.stageVideo.requestFullscreen?.());
window.addEventListener("beforeunload", () => {
  if (state.running) fetch(appPath(`/api/rooms/${state.roomCode}?clientId=${encodeURIComponent(state.clientId)}`), {
    method: "DELETE",
    keepalive: true,
    headers: { Authorization: `Bearer ${state.sessionToken}` },
  });
});

const initialCode = new URLSearchParams(location.search).get("room");
if (initialCode) elements.code.value = initialCode.toUpperCase().slice(0, 6);
const savedQuality = localStorage.getItem("syncast-quality");
if (Object.hasOwn(QUALITY_PROFILES, savedQuality)) state.preferredQuality = savedQuality;
const savedWindowAudioMode = localStorage.getItem("syncast-window-audio");
if (["isolated", "system"].includes(savedWindowAudioMode)) state.windowAudioMode = savedWindowAudioMode;
const savedTopologyMode = localStorage.getItem("syncast-topology-mode");
if (["auto", "direct", "relay"].includes(savedTopologyMode)) state.topologyMode = savedTopologyMode;
else if (localStorage.getItem("syncast-tree-topology") !== null) {
  state.topologyMode = localStorage.getItem("syncast-tree-topology") === "true" ? "relay" : "direct";
}
state.topologyEnabled = state.topologyMode === "relay";
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
