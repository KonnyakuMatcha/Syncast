(function (global) {
  "use strict";

  const DEFAULT_DIRECT_THRESHOLD = 3;
  const DEFAULT_MAX_CHILDREN = 2;

  function planTopology({
    hostId,
    participantIds,
    capabilities = {},
    enabled = false,
    directThreshold = DEFAULT_DIRECT_THRESHOLD,
    maxChildren = DEFAULT_MAX_CHILDREN,
  }) {
    const viewers = [...new Set(participantIds)].filter((id) => id && id !== hostId).sort();
    const parents = Object.fromEntries(viewers.map((id) => [id, hostId]));
    const children = { [hostId]: [...viewers] };
    if (!enabled || viewers.length <= directThreshold) {
      return { parents, children, relays: [] };
    }

    const targetRoots = Math.ceil(viewers.length / (maxChildren + 1));
    const candidates = viewers
      .filter((id) => capabilities[id]?.eligible)
      .sort((left, right) => {
        const scoreDifference = Number(capabilities[right]?.score || 0) - Number(capabilities[left]?.score || 0);
        return scoreDifference || left.localeCompare(right);
      });
    const relays = candidates.slice(0, targetRoots);
    if (!relays.length) return { parents, children, relays: [] };

    children[hostId] = [...relays];
    for (const relayId of relays) children[relayId] = [];

    for (const viewerId of viewers.filter((id) => !relays.includes(id))) {
      const relayId = relays
        .filter((id) => children[id].length < maxChildren)
        .filter((id) => capabilities[id]?.connectedPeers?.includes(viewerId))
        .sort((left, right) => children[left].length - children[right].length)[0];
      if (relayId) {
        parents[viewerId] = relayId;
        children[relayId].push(viewerId);
      } else {
        children[hostId].push(viewerId);
      }
    }

    return { parents, children, relays };
  }

  const api = { DEFAULT_DIRECT_THRESHOLD, DEFAULT_MAX_CHILDREN, planTopology };
  global.SyncastTopology = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
