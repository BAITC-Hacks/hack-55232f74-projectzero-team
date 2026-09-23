import { geography, project, unproject } from './geography'
import type { Point } from './geography'

// OSM-derived centrelines, simplified junctions, bidirectional game streets.
// Geometry does not imply calibrated travel times or official district boundaries.
export type DistrictId = 'esil' | 'almaty' | 'saryarka' | 'baikonur' | 'nura'
export type Junction = { id: string; x: number; z: number; district: DistrictId; index: number }
export type Road = {
  id: string
  a: Junction
  b: Junction
  points: Point[]
  cumulative: number[]
  length: number
  arterial: boolean
  bridge: boolean
  name: string
}
export type Edge = { id: string; road: Road; from: Junction; to: Junction; length: number }
export type BusLine = { id: string; name: string; color: string; nodes: string[]; stops: string[] }

export const districtAreas = [
  { id: 'saryarka', name: 'Сарыарка', lat: 51.167, lon: 71.399, color: '#dfad65' },
  { id: 'baikonur', name: 'Байконур', lat: 51.168, lon: 71.448, color: '#94abda' },
  { id: 'almaty', name: 'Алматы', lat: 51.147, lon: 71.475, color: '#ce97bc' },
  { id: 'nura', name: 'Нура', lat: 51.125, lon: 71.397, color: '#87baa0' },
  { id: 'esil', name: 'Есиль', lat: 51.105, lon: 71.431, color: '#7cafca' },
].map((area) => {
  const [x, z] = project(area.lat, area.lon)
  return { ...area, id: area.id as DistrictId, x, z }
})
export function districtAt(x: number, z: number): DistrictId {
  const [lat, lon] = unproject(x, z)
  if (lat > 51.154) return lon < 71.432 ? 'saryarka' : 'baikonur'
  if (lon > 71.45) return 'almaty'
  return lon < 71.418 ? 'nura' : 'esil'
}
export const junctions: Junction[] = geography.nodes.map((node, index) => ({
  id: node.id,
  x: node.point[0],
  z: node.point[1],
  district: districtAt(...(node.point as Point)),
  index,
}))
export const nodeById = new Map(junctions.map((n) => [n.id, n]))
export const roads: Road[] = geography.roads.map((road) => {
  const points = road.points as Point[],
    cumulative = [0]
  for (let i = 1; i < points.length; i++)
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]),
    )
  return {
    id: road.id,
    a: nodeById.get(road.a)!,
    b: nodeById.get(road.b)!,
    name: road.name,
    arterial: road.arterial,
    bridge: road.bridge,
    points,
    cumulative,
    length: cumulative.at(-1)!,
  }
})
export const edges: Edge[] = roads.flatMap((road) => [
  { id: `${road.a.id}>${road.b.id}`, road, from: road.a, to: road.b, length: road.length },
  { id: `${road.b.id}>${road.a.id}`, road, from: road.b, to: road.a, length: road.length },
])
export const edgeById = new Map(edges.map((edge) => [edge.id, edge]))
export const outgoing = new Map(junctions.map((node) => [node.id, [] as Edge[]]))
edges.forEach((edge) => outgoing.get(edge.from.id)!.push(edge))

// Cached shortest-path trees make repeated trips cheap on the larger OSM graph.
const routeTrees = new Map<string, Map<string, Edge>>()
export function shortestPath(from: string, to: string): Edge[] {
  if (!nodeById.has(from) || !nodeById.has(to)) return []
  if (!routeTrees.has(from)) {
    const distances = new Map([[from, 0]]),
      previous = new Map<string, Edge>()
    const heap: { id: string; cost: number }[] = [{ id: from, cost: 0 }]
    const push = (entry: { id: string; cost: number }) => {
      heap.push(entry)
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (heap[parent].cost <= entry.cost) break
        heap[i] = heap[parent]
        i = parent
      }
      heap[i] = entry
    }
    while (heap.length) {
      const current = heap[0],
        last = heap.pop()!
      if (heap.length) {
        let i = 0
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1
          if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++
          if (heap[child].cost >= last.cost) break
          heap[i] = heap[child]
          i = child
        }
        heap[i] = last
      }
      if (current.cost !== distances.get(current.id)) continue
      for (const edge of outgoing.get(current.id)!) {
        const cost = current.cost + edge.length * (edge.road.arterial ? 0.85 : 1)
        if (cost < (distances.get(edge.to.id) ?? Infinity)) {
          distances.set(edge.to.id, cost)
          previous.set(edge.to.id, edge)
          push({ id: edge.to.id, cost })
        }
      }
    }
    routeTrees.set(from, previous)
  }
  const path: Edge[] = [],
    previous = routeTrees.get(from)!
  let current = to
  while (current !== from) {
    const edge = previous.get(current)
    if (!edge) return []
    path.push(edge)
    current = edge.from.id
  }
  return path.reverse()
}
export function nearestNode(lat: number, lon: number, district?: DistrictId) {
  const [x, z] = project(lat, lon)
  return junctions
    .filter((n) => !district || n.district === district)
    .reduce((a, b) => (Math.hypot(a.x - x, a.z - z) < Math.hypot(b.x - x, b.z - z) ? a : b))
}
export function edgesForNodes(nodes: string[]): Edge[] {
  return nodes.slice(0, -1).map((id, i) => {
    const edge = edgeById.get(`${id}>${nodes[i + 1]}`)
    if (!edge) throw new Error(`Disconnected route: ${id}>${nodes[i + 1]}`)
    return edge
  })
}
function loop(points: Point[]): string[] {
  const anchors = points.map(([lat, lon]) => nearestNode(lat, lon)),
    result = [anchors[0].id]
  for (let i = 0; i < anchors.length; i++)
    result.push(
      ...shortestPath(anchors[i].id, anchors[(i + 1) % anchors.length].id).map((e) => e.to.id),
    )
  return result
}
const line = (id: string, name: string, color: string, points: Point[]): BusLine => {
  const nodes = loop(points),
    stops = [...new Set(points.map(([lat, lon]) => nearestNode(lat, lon).id))]
  let distance = 0
  for (const edge of edgesForNodes(nodes)) {
    distance += edge.length
    if (distance >= 100) {
      stops.push(edge.to.id)
      distance = 0
    }
  }
  return { id, name, color, nodes, stops: [...new Set(stops)] }
}
export const busLines: BusLine[] = [
  line('01', 'Хан Шатыр — Акорда', '#38c6c1', [
    [51.132, 71.402],
    [51.136, 71.426],
    [51.132, 71.445],
    [51.12, 71.445],
    [51.117, 71.414],
  ]),
  line('02', 'Правый берег — Центр', '#edb14a', [
    [51.135, 71.415],
    [51.149, 71.412],
    [51.165, 71.408],
    [51.166, 71.445],
    [51.15, 71.476],
    [51.132, 71.445],
  ]),
  line('03', 'EXPO — Нуржол', '#9d91e9', [
    [51.089, 71.42],
    [51.104, 71.409],
    [51.13, 71.409],
    [51.13, 71.439],
    [51.102, 71.437],
  ]),
]
export const tramLoops = Object.fromEntries(
  districtAreas.map((area) => [
    area.id,
    loop([
      [area.lat - 0.004, area.lon - 0.005],
      [area.lat + 0.004, area.lon - 0.005],
      [area.lat + 0.004, area.lon + 0.005],
      [area.lat - 0.004, area.lon + 0.005],
    ]),
  ]),
) as Record<DistrictId, string[]>
export const tripNodes = districtAreas.flatMap((area) =>
  junctions
    .filter((n) => n.district === area.id)
    .sort((a, b) => Math.hypot(a.x - area.x, a.z - area.z) - Math.hypot(b.x - area.x, b.z - area.z))
    .slice(0, 9),
)

export function elevation(road: Road, t: number) {
  return road.bridge ? 0.2 + Math.min(t * 5, (1 - t) * 5, 1) * 2.6 : 0.2
}
export function pointOnRoad(road: Road, position: number, offset = 0) {
  const clamped = Math.max(0, Math.min(road.length, position))
  let i = 1
  while (i < road.cumulative.length - 1 && road.cumulative[i] < clamped) i++
  const a = road.points[i - 1],
    b = road.points[i],
    segment = road.cumulative[i] - road.cumulative[i - 1]
  const dx = (b[0] - a[0]) / segment,
    dz = (b[1] - a[1]) / segment,
    t = (clamped - road.cumulative[i - 1]) / segment
  return {
    x: a[0] + (b[0] - a[0]) * t - dz * offset,
    z: a[1] + (b[1] - a[1]) * t + dx * offset,
    y: elevation(road, clamped / road.length),
    angle: Math.atan2(dx, dz),
  }
}
export function pointOnEdge(edge: Edge, position: number, busLane = false) {
  const forward = edge.from.id === edge.road.a.id,
    lane = busLane ? 3.2 : 1.4
  const point = pointOnRoad(
    edge.road,
    forward ? position : edge.length - position,
    forward ? lane : -lane,
  )
  if (!forward) point.angle += Math.PI
  return point
}
