(function (global) {
  "use strict";

  // Statistics describe this browser's SFU leg, not end-to-end latency.
  // Derive rates per RTP stream so simulcast/layer switches cannot produce spikes.
  function summarize(stats, previous, outbound) {
    const reports = [...stats.values()];
    const type = outbound ? "outbound-rtp" : "inbound-rtp";
    const rtp = reports.filter((s) => s.type === type && ["video", "audio"].includes(s.kind));
    const oldById = new Map((previous?.reports || []).map((s) => [s.id, s]));
    const result = { reports: rtp, outbound, streams: [], videoMbps: null, audioMbps: null,
      videoLoss: null, audioLoss: null, videoBufferMs: null, audioBufferMs: null,
      freezes: null, protocol: null, rttMs: null };
    const delta = (s, key) => {
      const old = oldById.get(s.id);
      if (!old || s.ssrc !== old.ssrc || s.timestamp <= old.timestamp
          || !Number.isFinite(s[key]) || !Number.isFinite(old[key]) || s[key] < old[key]) return null;
      return s[key] - old[key];
    };
    for (const kind of ["video", "audio"]) {
      let bitrate = 0, rateKnown = false, lost = 0, received = 0, lossKnown = false;
      let buffer = 0, emitted = 0, freezes = 0, freezesKnown = false;
      for (const s of rtp.filter((item) => item.kind === kind)) {
        const bytes = delta(s, outbound ? "bytesSent" : "bytesReceived");
        const elapsed = (s.timestamp - (oldById.get(s.id)?.timestamp ?? s.timestamp)) / 1000;
        const mbps = bytes === null ? null : bytes * 8 / elapsed / 1_000_000;
        if (mbps !== null) { bitrate += mbps; rateKnown = true; }
        if (kind === "video" && (!outbound || bytes === null || bytes > 0)) {
          const frames = delta(s, outbound ? "framesEncoded" : "framesDecoded");
          result.streams.push({ width: s.frameWidth, height: s.frameHeight,
            fps: frames === null ? null : frames / elapsed,
            limitation: outbound ? s.qualityLimitationReason : null });
        }
        const loss = delta(s, "packetsLost"), packets = delta(s, "packetsReceived");
        if (loss !== null && packets !== null) { lost += loss; received += packets; lossKnown = true; }
        const delay = delta(s, "jitterBufferDelay"), count = delta(s, "jitterBufferEmittedCount");
        if (delay !== null && count !== null) { buffer += delay; emitted += count; }
        const stalls = delta(s, "freezeCount");
        if (stalls !== null) { freezes += stalls; freezesKnown = true; }
      }
      result[`${kind}Mbps`] = rateKnown ? bitrate : null;
      result[`${kind}Loss`] = lossKnown && lost + received > 0 ? lost / (lost + received) * 100 : null;
      result[`${kind}BufferMs`] = emitted > 0 ? buffer / emitted * 1000 : null;
      if (kind === "video") result.freezes = freezesKnown ? freezes : null;
    }
    const transport = stats.get(rtp.find((s) => s.transportId)?.transportId)
      || reports.find((s) => s.type === "transport" && s.selectedCandidatePairId);
    const pair = stats.get(transport?.selectedCandidatePairId)
      || reports.find((s) => s.type === "candidate-pair" && s.state === "succeeded" && (s.selected || s.nominated));
    const candidate = stats.get(pair?.localCandidateId);
    if (["udp", "tcp"].includes(candidate?.protocol)) result.protocol = candidate.protocol.toUpperCase();
    if (Number.isFinite(pair?.currentRoundTripTime)) result.rttMs = pair.currentRoundTripTime * 1000;
    return result;
  }

  function format(sample) {
    if (!sample) return "正在采样共享流…";
    const parts = [sample.outbound ? "本机 → VPS" : "VPS → 本机"];
    if (sample.protocol) parts.push(sample.protocol);
    if (sample.rttMs !== null) parts.push(`往返 ${Math.round(sample.rttMs)} ms`);
    const lines = [parts.join(" · ")];
    const streams = sample.streams.filter((s) => s.width && s.height && s.fps !== null);
    if (streams.length) lines.push(streams.map((s) => `${s.width}×${s.height} / ${Math.round(s.fps)} 帧`).join(" + "));
    if (sample.videoMbps !== null) lines.push(`画面 ${sample.videoMbps.toFixed(2)} Mbps`
      + (sample.audioMbps !== null ? ` · 共享声音 ${Math.round(sample.audioMbps * 1000)} kbps` : ""));
    const metrics = [];
    if (sample.videoLoss !== null) metrics.push(`视频丢包 ${sample.videoLoss.toFixed(1)}%`);
    if (sample.audioLoss !== null) metrics.push(`共享声音丢包 ${sample.audioLoss.toFixed(1)}%`);
    if (sample.videoBufferMs !== null) metrics.push(`视频缓冲 ${Math.round(sample.videoBufferMs)} ms`);
    if (sample.audioBufferMs !== null) metrics.push(`声音缓冲 ${Math.round(sample.audioBufferMs)} ms`);
    if (sample.freezes > 0) metrics.push(`画面停顿 ${sample.freezes} 次`);
    if (metrics.length) lines.push(metrics.join(" · "));
    const reasons = new Set(sample.streams.map((s) => s.limitation));
    if (reasons.has("cpu")) lines.push("浏览器报告编码处理受限");
    if (reasons.has("bandwidth")) lines.push("浏览器报告发送带宽受限");
    if (sample.protocol === "TCP") lines.push("当前使用 TCP；若卡顿，请检查 VPS 的 7882/UDP 是否可达");
    return lines.join("\n");
  }

  const api = { summarize, format };
  global.SyncastBroadcastStats = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
