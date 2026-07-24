"use strict";

const assert = require("node:assert/strict");
const { planTopology } = require("../static/topology.js");

function capability(connectedPeers, score = 10) {
  return { eligible: true, connectedPeers, score };
}

function assertValidTree(topology, hostId, participantIds, maxChildren = 2) {
  const viewers = participantIds.filter((id) => id !== hostId);
  assert.deepEqual(Object.keys(topology.parents).sort(), [...viewers].sort());
  for (const relayId of topology.relays) {
    assert.ok((topology.children[relayId] || []).length <= maxChildren);
  }
  for (const viewerId of viewers) {
    const visited = new Set([viewerId]);
    let current = viewerId;
    let depth = 0;
    while (current !== hostId) {
      current = topology.parents[current];
      assert.ok(current, `${viewerId} must be reachable from the host`);
      assert.ok(!visited.has(current), `${viewerId} must not be part of a cycle`);
      visited.add(current);
      depth += 1;
      assert.ok(depth <= 2, `${viewerId} exceeds the maximum topology depth`);
    }
  }
}

const direct = planTopology({
  hostId: "host",
  participantIds: ["host", "a", "b", "c", "d"],
  enabled: false,
});
assert.deepEqual(direct.parents, { a: "host", b: "host", c: "host", d: "host" });
assert.deepEqual(direct.relays, []);

const smallRoom = planTopology({
  hostId: "host",
  participantIds: ["host", "a", "b", "c"],
  capabilities: { a: capability(["b", "c"]) },
  enabled: true,
});
assert.deepEqual(smallRoom.relays, []);

const distributed = planTopology({
  hostId: "host",
  participantIds: ["host", "a", "b", "c", "d", "e", "f", "g"],
  capabilities: {
    a: capability(["b", "c", "d", "e", "f", "g"], 30),
    b: capability(["a", "c", "d", "e", "f", "g"], 20),
    c: capability(["a", "b", "d", "e", "f", "g"], 10),
  },
  enabled: true,
});
assert.deepEqual(distributed.relays, ["a", "b", "c"]);
assert.equal(distributed.children.host.length, 3);
assert.ok(distributed.children.a.length <= 2);
assert.ok(distributed.children.b.length <= 2);
assert.ok(distributed.children.c.length <= 2);
assert.equal(Object.keys(distributed.parents).length, 7);
for (const [viewerId, parentId] of Object.entries(distributed.parents)) {
  assert.notEqual(viewerId, parentId);
}

const partialConnectivity = planTopology({
  hostId: "host",
  participantIds: ["host", "a", "b", "c", "d"],
  capabilities: { a: capability(["c"], 30), b: capability([], 20) },
  enabled: true,
});
assert.equal(partialConnectivity.parents.c, "a");
assert.equal(partialConnectivity.parents.d, "host");

const ineligible = planTopology({
  hostId: "host",
  participantIds: ["host", "a", "b", "c", "d"],
  capabilities: { a: { eligible: false, connectedPeers: ["b", "c", "d"], score: 100 } },
  enabled: true,
});
assert.deepEqual(ineligible.relays, []);

const tenViewers = Array.from({ length: 10 }, (_, index) => `viewer-${index + 1}`);
const allParticipants = ["host", ...tenViewers];
const fullyConnectedCapabilities = Object.fromEntries(tenViewers.map((id, index) => [
  id,
  capability(tenViewers.filter((peerId) => peerId !== id), 100 - index),
]));
const largeRoom = planTopology({
  hostId: "host",
  participantIds: allParticipants,
  capabilities: fullyConnectedCapabilities,
  enabled: true,
});
assertValidTree(largeRoom, "host", allParticipants);
assert.ok(largeRoom.relays.length > 0);
assert.ok(largeRoom.children.host.length < tenViewers.length);

const failedParent = largeRoom.relays[0];
const failedChild = largeRoom.children[failedParent][0];
assert.ok(failedChild, "test topology must include a relayed viewer");
const afterFailureCapabilities = structuredClone(fullyConnectedCapabilities);
afterFailureCapabilities[failedParent].connectedPeers = afterFailureCapabilities[failedParent].connectedPeers
  .filter((id) => id !== failedChild);
const afterFailure = planTopology({
  hostId: "host",
  participantIds: allParticipants,
  capabilities: afterFailureCapabilities,
  enabled: true,
});
assertValidTree(afterFailure, "host", allParticipants);
assert.notEqual(afterFailure.parents[failedChild], failedParent);

console.log("dynamic topology planner tests passed");
