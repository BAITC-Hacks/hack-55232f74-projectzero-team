// Offline importer: node scripts/import-astana.mjs roads-overpass.json [buildings-overpass.json]
// No network calls. Input queries and ODbL attribution are documented in docs/astana.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const structures = process.argv[3]
  ? JSON.parse(fs.readFileSync(process.argv[3], "utf8"))
  : { elements: [] };
if (raw.remark || structures.remark)
  throw new Error("Overpass returned an incomplete result");
const origin = [51.128, 71.43];
const bounds = [51.079, 71.38, 51.175, 71.493];
const project = ({ lat, lon }) => [
  +(
    ((lon - origin[1]) * 111320 * Math.cos((origin[0] * Math.PI) / 180)) /
    8
  ).toFixed(2),
  +(((origin[0] - lat) * 111320) / 8).toFixed(2),
];
const inside = (p) =>
  p.lat >= bounds[0] &&
  p.lat <= bounds[2] &&
  p.lon >= bounds[1] &&
  p.lon <= bounds[3];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (points) =>
  points.slice(1).reduce((s, p, i) => s + distance(points[i], p), 0);
const nameOf = (tags) => tags["name:ru"] || tags.name || tags["name:en"] || "";
const nodes = new Map(),
  segments = [];
for (const way of raw.elements.filter((w) => w.tags?.highway)) {
  const geometry = way.geometry;
  for (let i = 1; i < geometry.length; i++) {
    if (!inside(geometry[i - 1]) || !inside(geometry[i])) continue;
    const a = String(way.nodes[i - 1]),
      b = String(way.nodes[i]);
    if (a === b) continue;
    for (const [id, geo] of [
      [a, geometry[i - 1]],
      [b, geometry[i]],
    ]) {
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          point: project(geo),
          edges: [],
          layer: way.tags.layer || "0",
        });
    }
    const segment = {
      a,
      b,
      points: [nodes.get(a).point, nodes.get(b).point],
      name: nameOf(way.tags),
      arterial: /^(primary|secondary)/.test(way.tags.highway),
      bridge: way.tags.bridge === "yes",
      osm: way.id,
    };
    nodes.get(a).edges.push(segments.length);
    nodes.get(b).edges.push(segments.length);
    segments.push(segment);
  }
}
// Collapse shape nodes without losing their curved geometry.
const junctions = [...nodes.values()].filter((n) => n.edges.length !== 2);
const consumed = new Set(),
  traced = [];
for (const start of junctions)
  for (const first of start.edges) {
    if (consumed.has(first)) continue;
    const points = [start.point],
      sourceIds = new Set();
    let node = start,
      edgeId = first,
      name = "",
      arterial = false,
      bridge = false;
    while (!consumed.has(edgeId)) {
      consumed.add(edgeId);
      const edge = segments[edgeId];
      node = nodes.get(edge.a === node.id ? edge.b : edge.a);
      points.push(node.point);
      sourceIds.add(edge.osm);
      name ||= edge.name;
      arterial ||= edge.arterial;
      bridge ||= edge.bridge;
      if (node.edges.length !== 2) break;
      edgeId = node.edges.find((id) => id !== edgeId);
    }
    if (start.id !== node.id)
      traced.push({
        a: start.id,
        b: node.id,
        points,
        name,
        arterial,
        bridge,
        osm: [...sourceIds],
      });
  }
// Combine nearby junction mouths/carriageways; never merge different tagged levels.
// This intentionally produces a small, bidirectional game network, not turn-by-turn navigation.
const clusters = [],
  clusterById = new Map();
for (const node of junctions) {
  let cluster = clusters.find(
    (c) => c.layer === node.layer && distance(c.point, node.point) < 6,
  );
  if (!cluster) {
    cluster = {
      id: `j${clusters.length}`,
      point: [...node.point],
      layer: node.layer,
      members: [],
    };
    clusters.push(cluster);
  }
  cluster.members.push(node.point);
  clusterById.set(node.id, cluster);
}
for (const cluster of clusters)
  cluster.point = [0, 1].map(
    (axis) =>
      +(
        cluster.members.reduce((sum, p) => sum + p[axis], 0) /
        cluster.members.length
      ).toFixed(2),
  );
const unique = new Map();
for (const road of traced) {
  const a = clusterById.get(road.a),
    b = clusterById.get(road.b);
  if (!a || !b || a.id === b.id || distance(a.point, b.point) < 4) continue;
  road.a = a.id;
  road.b = b.id;
  road.points[0] = a.point;
  road.points[road.points.length - 1] = b.point;
  const key = [road.a, road.b].sort().join(":");
  const prior = unique.get(key);
  if (!prior || length(road.points) < length(prior.points)) {
    if (prior) {
      road.osm = [...new Set([...prior.osm, ...road.osm])];
      road.bridge ||= prior.bridge;
    }
    unique.set(key, road);
  } else {
    prior.osm = [...new Set([...prior.osm, ...road.osm])];
    prior.bridge ||= road.bridge;
  }
}
const adjacency = new Map(clusters.map((c) => [c.id, []]));
for (const r of unique.values()) {
  adjacency.get(r.a).push(r.b);
  adjacency.get(r.b).push(r.a);
}
const unseen = new Set(clusters.map((c) => c.id)),
  components = [];
while (unseen.size) {
  const stack = [unseen.values().next().value],
    component = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (!unseen.delete(id)) continue;
    component.add(id);
    stack.push(...adjacency.get(id));
  }
  components.push(component);
}
components.sort((a, b) => b.size - a.size);
const retained = components[0];
const roads = [...unique.values()]
  .filter((r) => retained.has(r.a) && retained.has(r.b))
  .map((r, i) => ({
    id: `r${i}`,
    ...r,
    name: r.name || "Соединительная улица",
  }));
// Collinear point thinning removes sub-metre noise while retaining bends.
const simplify = (points) =>
  points.filter((p, i) => {
    if (i === 0 || i === points.length - 1) return true;
    const a = points[i - 1],
      b = points[i + 1],
      d = distance(a, b);
    return (
      d < 0.01 ||
      Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) /
        d >
        0.1
    );
  });
roads.forEach((r) => (r.points = simplify(r.points)));
const rivers = raw.elements
  .filter((w) => w.tags?.waterway === "river")
  .map((w) => ({
    id: w.id,
    name: nameOf(w.tags) || "Приток Ишима",
    width: /Ес|Ишим/.test(nameOf(w.tags)) ? 18 : 7,
    points: simplify(w.geometry.map(project)),
  }));
const polygonArea = (points) =>
  Math.abs(
    points.reduce((s, p, i) => {
      const q = points[(i + 1) % points.length];
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
const buildings = [],
  parks = [];
for (const w of structures.elements) {
  if (!w.geometry || w.geometry.length < 4 || w.nodes[0] !== w.nodes.at(-1))
    continue;
  const points = simplify(w.geometry.slice(0, -1).map(project));
  if (points.length < 3 || points.some((p) => !p.every(Number.isFinite)))
    continue;
  if (w.tags.leisure === "park") {
    parks.push({ id: w.id, name: nameOf(w.tags), points });
    continue;
  }
  if (!w.tags.building || polygonArea(points) < 2) continue;
  const levels = parseFloat(w.tags["building:levels"]);
  const taggedHeight = parseFloat(w.tags.height);
  const estimated = ["house", "detached", "garage", "garages"].includes(
    w.tags.building,
  )
    ? 7
    : ["school", "kindergarten", "retail"].includes(w.tags.building)
      ? 12
      : 20 + (w.id % 23);
  const metres =
    taggedHeight > 0 ? taggedHeight : levels > 0 ? levels * 3.2 : estimated;
  buildings.push({
    id: w.id,
    name: nameOf(w.tags),
    points,
    height: +(Math.min(250, metres) / 3.5).toFixed(2),
    heightSource:
      taggedHeight > 0 ? "height" : levels > 0 ? "levels" : "estimated",
  });
}
const output = {
  source: "OpenStreetMap contributors",
  license: "ODbL-1.0",
  attribution: "https://www.openstreetmap.org/copyright",
  timestamp: raw.osm3s.timestamp_osm_base,
  buildingTimestamp: structures.osm3s?.timestamp_osm_base || null,
  origin,
  bounds,
  metresPerUnit: 8,
  nodes: clusters
    .filter((c) => retained.has(c.id))
    .map((c) => ({ id: c.id, point: c.point })),
  roads,
  rivers,
  buildings,
  parks,
};
const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../app/src/traffic/data/astana.json",
);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(output) + "\n");
console.log(
  JSON.stringify(
    {
      nodes: output.nodes.length,
      roads: roads.length,
      rivers: rivers.length,
      buildings: buildings.length,
      parks: parks.length,
      bytes: fs.statSync(target).size,
      discardedComponents: components.slice(1).map((c) => c.size),
    },
    null,
    2,
  ),
);
