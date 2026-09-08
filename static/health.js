(function (global) {
  "use strict";

  const REPORT_TTL_MS = 20000;
  const STALL_MS = 15000;

  function summarizeStats(stats) {
    const reports = [...stats.values()];
    const incoming = (kind) => reports.filter((s) => s.type === "inbound-rtp" && s.kind === kind);
    const outgoing = (kind) => reports.filter((s) => s.type === "outbound-rtp" && s.kind === kind);
    const sum = (items, key) => items.reduce((n, item) => n + (Number(item[key]) || 0), 0);
    const video = incoming("video"), audio = incoming("audio");
    const sentVideo = outgoing("video"), sentAudio = outgoing("audio");
    const transport = reports.find((s) => s.type === "transport" && s.selectedCandidatePairId);
    const pair = stats.get(transport?.selectedCandidatePairId)
      || reports.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
    return {
      videoId: video.map((s) => s.id).sort().join(","),
      audioId: audio.map((s) => s.id).sort().join(","),
      videoFrames: sum(video, "framesDecoded"), videoBytes: sum(video, "bytesReceived"),
      audioBytes: sum(audio, "bytesReceived"),
      sentVideoId: sentVideo.map((s) => s.id).sort().join(","),
      sentAudioId: sentAudio.map((s) => s.id).sort().join(","),
      sentVideoFrames: sum(sentVideo, "framesEncoded"), sentAudioBytes: sum(sentAudio, "bytesSent"),
      rtt: Number.isFinite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null,
      cpuLimited: sentVideo.some((s) => s.framesEncoded > 0 && s.qualityLimitationReason === "cpu"),
    };
  }

  function sanitizeReport(report, memberIds) {
    if (!report || !Number.isSafeInteger(report.serial) || report.serial < 1) return null;
    const clean = { serial: report.serial, cpuLimited: report.cpuLimited === true, links: {}, stage: {} };
    const ids = [...memberIds];
    for (const group of ["links", "stage"]) {
      for (const id of ids) {
        const item = report[group]?.[id];
        if (!item || typeof item !== "object") continue;
        const entry = { connected: item.connected === true };
        for (const key of ["videoFrames", "audioBytes"]) {
          if (Number.isSafeInteger(item[key]) && item[key] >= 0) entry[key] = item[key];
        }
        for (const key of ["videoId", "audioId"]) entry[key] = String(item[key] || "").slice(0, 200);
        entry.rtt = Number.isFinite(item.rtt) && item.rtt >= 0 && item.rtt <= 5000 ? item.rtt : null;
        clean[group][id] = entry;
      }
    }
    return clean;
  }

  function updateProgress(previous, sample, { video = false, audio = false, source = null } = {}, now = Date.now()) {
    const old = previous?.sample;
    const next = { ...previous, sample, source, videoStalled: false, audioStalled: false };
    for (const kind of ["video", "audio"]) {
      const counter = kind === "video" ? "videoFrames" : "audioBytes";
      const key = `${kind}Id`, since = `${kind}Since`, until = `${kind}ExpectedUntil`;
      const enabled = kind === "video" ? video : audio;
      const progressed = old && sample[counter] > old[counter];
      const reset = old && (sample[counter] < old[counter] || sample[key] !== old[key]);
      if (source && (!previous?.source || source.serial !== previous.source.serial)) {
        const prior = previous?.source;
        next[until] = prior && source.peerId === prior.peerId && source[key] === prior[key]
          && source[counter] > prior[counter] ? now + 12000 : 0;
      }
      // Incoming video packets without decoded frames are also evidence of
      // a stuck decoder. A static source or silent sender is not evidence.
      const decoderWaiting = kind === "video" && old && sample.videoBytes > old.videoBytes;
      const expected = (source && next[until] > now) || decoderWaiting;
      if (!enabled || !old || progressed || reset || !expected) next[since] = null;
      else next[since] = previous?.[since] ?? now;
      next[`${kind}Stalled`] = next[since] !== null && now - next[since] >= STALL_MS;
    }
    return next;
  }

  const api = { REPORT_TTL_MS, STALL_MS, summarizeStats, sanitizeReport, updateProgress };
  global.SyncastHealth = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
