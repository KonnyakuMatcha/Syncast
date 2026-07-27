(function (global) {
  "use strict";

  const DEFAULT_MAX_CHILDREN = 3;
  const DEFAULT_MAX_DEPTH = 2;

  function selectedRouteUsesTurn(stats) {
    let pair;
    for (const report of stats.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
        break;
      }
    }
    if (!pair) {
      pair = [...stats.values()].find((report) => (
        report.type === "candidate-pair" && report.nominated && report.state === "succeeded"
      ));
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return local?.candidateType === "relay" || remote?.candidateType === "relay";
  }

  function planTopology(memberIds, hostId, options = {}) {
    const orderedIds = [...new Set(memberIds)].filter(Boolean);
    if (!orderedIds.includes(hostId)) orderedIds.unshift(hostId);
    const enabled = Boolean(options.enabled);
    const maxChildren = Math.max(1, Number(options.maxChildren) || DEFAULT_MAX_CHILDREN);
    const maxDepth = Math.max(1, Number(options.maxDepth) || DEFAULT_MAX_DEPTH);
    const relayIds = new Set(options.relayIds || orderedIds);
    const blockedEdges = options.blockedEdges;
    const blockedParentsFor = (id) => new Set(
      blockedEdges instanceof Map ? blockedEdges.get(id) : blockedEdges?.[id],
    );
    const plan = Object.fromEntries(orderedIds.map((id) => [id, {
      parentId: "",
      childIds: [],
      depth: id === hostId ? 0 : 1,
    }]));

    if (!enabled) {
      for (const id of orderedIds) {
        if (id === hostId) continue;
        plan[id].parentId = hostId;
        plan[hostId].childIds.push(id);
      }
      return plan;
    }

    const guests = orderedIds.filter((id) => id !== hostId);
    const relayGuests = guests
      .filter((id) => relayIds.has(id))
      .sort((left, right) => (
        Number(blockedParentsFor(left).has(hostId)) - Number(blockedParentsFor(right).has(hostId))
      ));
    const leafGuests = guests.filter((id) => !relayGuests.includes(id));
    const parentQueue = [hostId];

    for (const id of [...relayGuests, ...leafGuests]) {
      const blockedParents = blockedParentsFor(id);
      const parentId = parentQueue.find((candidateId) => (
        plan[candidateId].depth < maxDepth
        && plan[candidateId].childIds.length < maxChildren
        && !blockedParents.has(candidateId)
      )) || parentQueue.find((candidateId) => (
        plan[candidateId].depth < maxDepth
        && plan[candidateId].childIds.length < maxChildren
      )) || hostId;
      plan[id].parentId = parentId;
      plan[id].depth = plan[parentId].depth + 1;
      plan[parentId].childIds.push(id);
      if (relayIds.has(id) && plan[id].depth < maxDepth) {
        parentQueue.push(id);
      }
    }

    return plan;
  }

  const api = {
    DEFAULT_MAX_CHILDREN,
    DEFAULT_MAX_DEPTH,
    planTopology,
    selectedRouteUsesTurn,
  };
  global.SyncastTopology = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
