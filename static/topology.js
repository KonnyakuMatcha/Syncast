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
    const attached = new Set([hostId]);
    const previous = options.previousPlan || {};
    const canParent = (id) => attached.has(id)
      && (id === hostId || relayIds.has(id))
      && plan[id].depth < maxDepth
      && plan[id].childIds.length < maxChildren;
    const attach = (id, parentId) => {
      plan[id].parentId = parentId;
      plan[id].depth = plan[parentId].depth + 1;
      plan[parentId].childIds.push(id);
      attached.add(id);
    };
    // Preserve valid branches before allocating new members. Process parents
    // first; never trust a supplied depth or carry a cycle into the new tree.
    for (let depth = 0; depth < maxDepth; depth += 1) {
      for (const id of [...relayGuests, ...leafGuests]) {
        const parentId = previous[id]?.parentId;
        if (!attached.has(id) && canParent(parentId)
            && !blockedParentsFor(id).has(parentId)) attach(id, parentId);
      }
    }

    for (const id of [...relayGuests, ...leafGuests]) {
      if (attached.has(id)) continue;
      const parents = [...attached].filter(canParent);
      const available = parents.filter((parentId) => !blockedParentsFor(id).has(parentId));
      const candidates = available.length ? available : parents;
      // Short paths first, then spread new viewers over available relays.
      candidates.sort((a, b) => plan[a].depth - plan[b].depth
        || plan[a].childIds.length - plan[b].childIds.length);
      attach(id, candidates[0] || hostId);
    }

    return plan;
  }

  function updateAutoRelay(previous, { viewers, pressured, sharing }) {
    if (!sharing || viewers < 4) return { enabled: false, pressureSamples: 0 };
    const pressureSamples = pressured ? previous.pressureSamples + 1 : 0;
    // Keep the decision for this share to avoid repeatedly moving viewers
    // when offloading the host makes the pressure disappear.
    return { enabled: previous.enabled || pressureSamples >= 3, pressureSamples };
  }

  const api = {
    DEFAULT_MAX_CHILDREN,
    DEFAULT_MAX_DEPTH,
    planTopology,
    selectedRouteUsesTurn,
    updateAutoRelay,
  };
  global.SyncastTopology = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
