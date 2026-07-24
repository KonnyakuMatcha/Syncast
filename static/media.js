(function (global) {
  "use strict";

  const SYSTEM_AUDIO_BITRATE = 192_000;
  const OPUS_MUSIC_PARAMETERS = {
    stereo: "1",
    "sprop-stereo": "1",
    maxaveragebitrate: String(SYSTEM_AUDIO_BITRATE),
    maxplaybackrate: "48000",
    useinbandfec: "1",
    usedtx: "0",
  };

  function enhanceSystemAudio(description) {
    if (!description?.sdp) return description;
    const opus = description.sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!opus) return description;

    const payload = opus[1];
    const fmtpPattern = new RegExp(`^a=fmtp:${payload}\\s+([^\\r\\n]*)$`, "im");
    const existing = description.sdp.match(fmtpPattern);
    const preserved = (existing?.[1] || "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => !Object.hasOwn(OPUS_MUSIC_PARAMETERS, value.split("=", 1)[0].toLowerCase()));
    const parameters = [
      ...preserved,
      ...Object.entries(OPUS_MUSIC_PARAMETERS).map(([key, value]) => `${key}=${value}`),
    ].join(";");
    const fmtp = `a=fmtp:${payload} ${parameters}`;

    const sdp = existing
      ? description.sdp.replace(fmtpPattern, fmtp)
      : description.sdp.replace(opus[0], `${opus[0]}\r\n${fmtp}`);
    return { type: description.type, sdp };
  }

  function getWindowAudioPreference(mode) {
    return mode === "system" ? "system" : "window";
  }

  function isIsolatedAudioSafe(displaySurface, windowAudioMode = "isolated") {
    return displaySurface === "browser"
      || (displaySurface === "window" && windowAudioMode === "isolated");
  }

  const api = {
    SYSTEM_AUDIO_BITRATE,
    enhanceSystemAudio,
    getWindowAudioPreference,
    isIsolatedAudioSafe,
  };
  global.SyncastMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
