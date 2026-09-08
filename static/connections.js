"use strict";

function peerTransportConnected(peer) {
  return peer?.pc.connectionState === "connected" && ["connected", "completed"].includes(peer.pc.iceConnectionState);
}

function freshPeerHealth() {
  return new Map([...state.peerHealth].filter(([, report]) => Date.now() - report.receivedAt < SyncastHealth.REPORT_TTL_MS));
}

function acceptPeerHealth(peerId, raw) {
  const report = SyncastHealth.sanitizeReport(raw, state.participants.keys());
  const previous = state.peerHealth.get(peerId);
  if (!report || report.serial <= (previous?.serial || 0)) return;
  const cpuSamples = report.cpuLimited
    ? (previous && Date.now() - previous.receivedAt < SyncastHealth.REPORT_TTL_MS ? previous.cpuSamples : 0) + 1 : 0;
  state.peerHealth.set(peerId, { ...report, cpuSamples, cpuLimited: cpuSamples >= 2, receivedAt: Date.now() });
}

async function monitorConnections(sampleTime = Date.now()) {
  if (!state.running || state.healthBusy) return;
  state.healthBusy = true;
  try {
    const entries = [
      ...[...state.voicePeers].map(([id, peer]) => ({ channel: "voice", id, peer })),
      ...[...state.stagePeers].filter(([, peer]) => !peer.retiring).map(([id, peer]) => ({ channel: "stage", id, peer })),
    ];
    const results = await Promise.allSettled(entries.map(async (entry) => ({
      ...entry, sample: SyncastHealth.summarizeStats(await entry.peer.pc.getStats()),
    })));
    if (!state.running) return;
    const report = { serial: ++state.healthSerial, cpuLimited: false, links: {}, stage: {} };
    const health = freshPeerHealth();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { channel, id, peer, sample } = result.value;
      if ((channel === "voice" ? state.voicePeers : state.stagePeers).get(id) !== peer) continue;
      peer.sample = sample;
      const connected = peerTransportConnected(peer);
      const outgoing = { connected, rtt: sample.rtt, videoFrames: sample.sentVideoFrames,
        audioBytes: sample.sentAudioBytes, videoId: sample.sentVideoId, audioId: sample.sentAudioId };
      if (channel === "voice") report.links[id] = outgoing;
      else if (peer.outbound) {
        report.stage[id] = outgoing;
        report.cpuLimited ||= sample.cpuLimited;
      }
      if (!connected) {
        if (peer.pc.connectionState === "new" && Date.now() - peer.createdAt >= 15000) {
          schedulePeerRecovery(channel, id, peer, 0);
        }
        continue;
      }
      if (channel === "stage" && peer.outbound) continue;
      const sender = health.get(id);
      const counters = sender?.[channel === "voice" ? "links" : "stage"]?.[state.clientId];
      const source = counters?.connected ? { ...counters, serial: sender.serial, peerId: id } : null;
      const oldSample = peer.progress?.sample;
      const audioExpected = channel === "voice" ? state.memberStates.get(id)?.muted !== true
        : state.stageHasAudio && state.stageAudioEnabled && state.sharedSoundEnabled;
      peer.progress = SyncastHealth.updateProgress(peer.progress, sample, {
        video: channel === "stage" && state.stageExpected,
        audio: audioExpected,
        source,
      }, sampleTime);
      peer.mediaStalled = peer.progress.videoStalled || peer.progress.audioStalled;
      if (peer.progress.audioStalled) peer.recoveryAudioNeeded = true;
      if (!audioExpected || sample.audioBytes > (oldSample?.audioBytes || 0)) peer.recoveryAudioNeeded = false;
      const growing = channel === "stage"
        ? sample.videoFrames > (oldSample?.videoFrames || 0)
        : sample.audioBytes > (oldSample?.audioBytes || 0);
      if (!peer.mediaStalled && growing && !peer.recoveryAudioNeeded) {
        peer.awaitingMedia = false;
        peer.recoveryExhausted = false;
        peer.recoveryAttempts = 0;
      }
      if (peer.mediaStalled) schedulePeerRecovery(channel, id, peer, 0);
    }
    acceptPeerHealth(state.clientId, report);
    // Exchange counters, reachability and RTT only; no candidate addresses or
    // media are sent through signaling. Reports expire after twenty seconds.
    await Promise.all([...state.participants.keys()].filter((id) => id !== state.clientId)
      .map((id) => sendSignal(id, { channel: "peer-health", report })));
    renderParticipants();
  } catch (error) {
    console.warn("Unable to inspect connection health", error);
  } finally {
    state.healthBusy = false;
  }
}

function peerProblem(peer) {
  if (peer?.recoveryExhausted) return "连接未恢复";
  if (peer?.progress?.videoStalled) return "画面停滞";
  if (peer?.progress?.audioStalled) return "声音停滞";
  if (!peerTransportConnected(peer)) return "连接中";
  if (peer.awaitingMedia) return "等待媒体";
  return "";
}

function renderConnectionStatus() {
  if (!state.running) return;
  elements.signalStatus.textContent = state.signalingOnline ? "已连接" : "正在重连";
  const guests = [...state.participants.keys()].filter((id) => id !== state.clientId);
  const voiceProblems = guests.filter((id) => peerProblem(state.voicePeers.get(id)));
  const connected = guests.length - voiceProblems.length;
  elements.voiceStatus.textContent = !guests.length ? "等待其他成员" : `已连接 ${connected}/${guests.length}`;
  const stageIds = state.isHost ? [...state.stageChildIds] : [state.stageParentId].filter(Boolean);
  const stageProblems = state.stageExpected ? stageIds.filter((id) => peerProblem(state.stagePeers.get(id))) : [];
  const incoming = state.stagePeers.get(state.stageParentId);
  elements.stageConnectionStatus.textContent = !state.stageExpected ? "等待共享"
    : stageProblems.length ? (state.isHost ? `部分连接异常 ${stageProblems.length}` : peerProblem(incoming))
    : state.isHost ? (stageIds.length ? `发送中 · ${stageIds.length} 路` : "等待观众")
    : elements.stageVideo.paused ? "等待播放" : "播放中";
  const name = (id) => state.participants.get(id)?.name || "成员";
  const details = [];
  for (const id of voiceProblems) details.push(`语音 · ${name(id)}：${peerProblem(state.voicePeers.get(id))}`);
  for (const id of stageProblems) details.push(`直播 · ${name(id)}：${peerProblem(state.stagePeers.get(id))}`);
  elements.connectionDetails.textContent = details.join("；");
  elements.reconnect.disabled = state.reconnecting;
  elements.reconnect.textContent = state.reconnecting ? "正在重连…" : "重新连接";
}

async function reconnectMedia() {
  if (!state.running || state.reconnecting) return;
  state.reconnecting = true;
  renderConnectionStatus();
  try {
    for (const audio of elements.remoteAudio.querySelectorAll("audio")) audio.play().catch(() => {});
    if (elements.stageVideo.srcObject) elements.stageVideo.play().catch(() => {});
    const all = [
      ...[...state.voicePeers].map(([id, peer]) => ({ id, peer, channel: "voice" })),
      ...[...state.stagePeers].filter(([, peer]) => !peer.retiring).map(([id, peer]) => ({ id, peer, channel: "stage" })),
    ];
    const affected = all.filter(({ peer }) => peerProblem(peer));
    await Promise.allSettled((affected.length ? affected : all).map(async ({ id, peer, channel }) => {
      clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
      peer.recoveryAttempts = 0;
      peer.recoveryExhausted = false;
      peer.lastRestartAt = 0;
      if (ownsPeerOffer(channel, id, peer)) await restartPeer(channel, id, peer);
      else await sendSignal(id, { channel: "peer-restart", mediaChannel: channel });
      schedulePeerRecovery(channel, id, peer, 8000);
    }));
    for (const id of state.participants.keys()) {
      if (id !== state.clientId && !state.voicePeers.has(id)) await offerVoice(id);
    }
    if (!state.isHost && state.stageExpected && !state.stagePeers.has(state.stageParentId)) {
      await sendSignal(state.stageParentId, { channel: "stage-rebuild", version: state.topologyVersion });
    }
  } finally {
    state.reconnecting = false;
    renderConnectionStatus();
  }
}
