"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  planTopology,
  selectedRouteUsesTurn,
  updateAutoRelay,
} = require("../static/topology.js");

const members = ["host", "a", "b", "c", "d", "e", "f", "g"];
const star = planTopology(members, "host");
assert.deepEqual(star.host.childIds, members.slice(1));
assert.equal(star.g.parentId, "host");

const tree = planTopology(members, "host", { enabled: true });
assert.equal(DEFAULT_MAX_CHILDREN, 3);
assert.equal(DEFAULT_MAX_DEPTH, 2);
assert.deepEqual(tree.host.childIds, ["a", "b", "c"]);
assert.deepEqual(tree.a.childIds, ["d", "g"]);
assert.deepEqual(tree.b.childIds, ["e"]);
assert.deepEqual(tree.c.childIds, ["f"]);
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

const added = planTopology([...members, 'h'], 'host', { enabled: true, previousPlan: tree });
for (const id of members) assert.equal(added[id].parentId, tree[id].parentId);
const departed = planTopology(members.filter(id => id !== 'a'), 'host', {
  enabled: true, previousPlan: tree,
});
for (const id of ['b', 'c', 'e', 'f']) assert.equal(departed[id].parentId, tree[id].parentId);
for (const id of ['d', 'g']) assert.notEqual(departed[id].parentId, 'a');
const cyclicPrevious = planTopology(members, 'host', {
  enabled: true, previousPlan: { a: { parentId: 'b' }, b: { parentId: 'a' } },
});
for (const id of members) {
  const visited = new Set();
  let cursor = id;
  while (cursor) {
    assert.ok(!visited.has(cursor), 'Topology must be acyclic');
    visited.add(cursor);
    cursor = cyclicPrevious[cursor].parentId;
  }
}

let auto = { enabled: false, pressureSamples: 0 };
const pressure = { viewers: 7, sharing: true, pressured: true };
auto = updateAutoRelay(auto, pressure);
auto = updateAutoRelay(auto, pressure);
assert.equal(auto.enabled, false, 'A brief spike should not move viewers');
auto = updateAutoRelay(auto, { ...pressure, pressured: false });
assert.equal(auto.pressureSamples, 0);
for (let i = 0; i < 3; i++) auto = updateAutoRelay(auto, pressure);
assert.equal(auto.enabled, true);
assert.equal(updateAutoRelay(auto, { ...pressure, pressured: false }).enabled, true);
assert.equal(updateAutoRelay(auto, { ...pressure, sharing: false }).enabled, false);
assert.equal(updateAutoRelay(auto, { ...pressure, viewers: 3 }).enabled, false);


const health = {
  a: { cpuLimited: true, links: { host: { connected: true, rtt: 5 } } },
  b: { links: { host: { connected: true, rtt: 20 }, d: { connected: true, rtt: 10 } } },
  c: { links: { host: { connected: true, rtt: 30 }, d: { connected: false } } },
  d: { links: { host: { connected: true, rtt: 40 }, b: { connected: true, rtt: 10 } } },
};
const scored = planTopology(['host', 'a', 'b', 'c', 'd'], 'host', { enabled: true, health });
assert.ok(!scored.host.childIds.includes('a'), 'Prefer a relay without encoding pressure');
const reachable = planTopology(['host', 'a', 'b', 'c', 'd'], 'host', {
  enabled: true, relayIds: ['host', 'b', 'c'], health, maxChildren: 2,
});
assert.equal(reachable.d.parentId, 'b', 'Prefer an already connected relay over a known failed link');
const retained = planTopology(members, 'host', { enabled: true, health, previousPlan: tree });
for (const id of members) assert.equal(retained[id].parentId, tree[id].parentId, 'New scores must not churn healthy branches');

console.log("topology planner tests passed");
