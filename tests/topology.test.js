"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  planTopology,
  selectedRouteUsesTurn,
} = require("../static/topology.js");

const members = ["host", "a", "b", "c", "d", "e", "f", "g"];
const star = planTopology(members, "host");
assert.deepEqual(star.host.childIds, members.slice(1));
assert.equal(star.g.parentId, "host");

const tree = planTopology(members, "host", { enabled: true });
assert.equal(DEFAULT_MAX_CHILDREN, 3);
assert.equal(DEFAULT_MAX_DEPTH, 2);
assert.deepEqual(tree.host.childIds, ["a", "b", "c"]);
assert.deepEqual(tree.a.childIds, ["d", "e", "f"]);
assert.deepEqual(tree.b.childIds, ["g"]);
assert.equal(Math.max(...Object.values(tree).map((node) => node.depth)), 2);

const fullRoom = planTopology(
  ["host", ...Array.from({ length: 11 }, (_, index) => `guest-${index + 1}`)],
  "host",
  { enabled: true },
);
assert.equal(fullRoom.host.childIds.length, 3);
assert.equal(Math.max(...Object.values(fullRoom).map((node) => node.depth)), 2);
assert.equal(Object.values(fullRoom).reduce((total, node) => total + node.childIds.length, 0), 11);
assert.ok(Object.values(fullRoom).every((node) => node.childIds.length <= DEFAULT_MAX_CHILDREN));

const desktopOnly = planTopology(members, "host", {
  enabled: true,
  relayIds: ["host", "b"],
});
assert.deepEqual(desktopOnly.host.childIds, ["b", "a", "c", "g"]);
assert.deepEqual(desktopOnly.b.childIds, ["d", "e", "f"]);
assert.equal(desktopOnly.g.parentId, "host");

const blocked = planTopology(members, "host", {
  enabled: true,
  relayIds: members,
  blockedEdges: new Map([["a", new Set(["host"])]]),
});
assert.deepEqual(blocked.host.childIds, ["b", "c", "d"]);
assert.notEqual(blocked.a.parentId, "host");

for (const [id, node] of Object.entries(tree)) {
  for (const childId of node.childIds) assert.equal(tree[childId].parentId, id);
}

function routeStats(localType, remoteType) {
  return new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local", remoteCandidateId: "remote" }],
    ["local", { type: "local-candidate", candidateType: localType }],
    ["remote", { type: "remote-candidate", candidateType: remoteType }],
  ]);
}

assert.equal(selectedRouteUsesTurn(routeStats("host", "srflx")), false);
assert.equal(selectedRouteUsesTurn(routeStats("relay", "srflx")), true);
assert.equal(selectedRouteUsesTurn(new Map()), null);

console.log("topology planner tests passed");
