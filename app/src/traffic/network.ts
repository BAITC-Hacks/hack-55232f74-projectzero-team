// A deliberately schematic city network. These are NOT surveyed Astana roads.
// One scene unit represents two model metres; geometry is shared by simulation and rendering.
export type DistrictId = 'esil' | 'almaty' | 'saryarka' | 'baikonur' | 'nura'
export type Junction = { id: string; x: number; z: number; district: DistrictId; index: number }
export type Road = {
  id: string
  a: Junction
  b: Junction
  length: number
  arterial: boolean
  bridge: boolean
  name: string
}
export type Edge = { id: string; road: Road; from: Junction; to: Junction; length: number }
export type BusLine = { id: string; name: string; color: string; nodes: string[] }

export const XS = [-330, -220, -110, 0, 110, 220, 330]
export const ZS = [-260, -160, -60, 60, 160, 260]
export const districtAreas = [
  { id: 'saryarka', name: 'Сарыарка', x: -220, z: -170, color: '#dfad65' },
  { id: 'baikonur', name: 'Байконур', x: 0, z: -170, color: '#94abda' },
  { id: 'almaty', name: 'Алматы', x: 250, z: -140, color: '#ce97bc' },
  { id: 'nura', name: 'Нура', x: -230, z: 180, color: '#87baa0' },
  { id: 'esil', name: 'Есиль', x: 160, z: 185, color: '#7cafca' },
] as const

export function districtAt(x: number, z: number): DistrictId {
  if (z > 0) return x < -50 ? 'nura' : 'esil'
  return x < -110 ? 'saryarka' : x < 160 ? 'baikonur' : 'almaty'
}

export const junctions: Junction[] = ZS.flatMap((z, row) =>
  XS.map((x, col) => ({
    id: `n${row}_${col}`,
    x,
    z,
    district: districtAt(x, z),
    index: row * XS.length + col,
  })),
)
export const nodeById = new Map(junctions.map((n) => [n.id, n]))
export const roads: Road[] = []
for (let row = 0; row < ZS.length; row++) {
  for (let col = 0; col < XS.length; col++) {
    const a = nodeById.get(`n${row}_${col}`)!
    for (const [r, c] of [
      [row, col + 1],
      [row + 1, col],
    ]) {
      const b = nodeById.get(`n${r}_${c}`)
      if (!b) continue
      const bridge = row === 2 && r === 3
      if (bridge && ![1, 3, 5].includes(col)) continue
      roads.push({
        id: `${a.id}-${b.id}`,
        a,
        b,
        bridge,
        arterial: bridge || (row === r ? [1, 4].includes(row) : [1, 3, 5].includes(col)),
        length: Math.hypot(a.x - b.x, a.z - b.z),
        name: bridge
          ? ['Западный мост', 'Центральный мост', 'Восточный мост'][[1, 3, 5].indexOf(col)]
          : row === r
            ? [
                'Северная улица',
                'Проспект Единства',
                'Набережная',
                'Бульвар будущего',
                'Проспект Развития',
                'Южная улица',
              ][row]
            : `Городская улица ${col + 1}`,
      })
    }
  }
}
export const edges: Edge[] = roads.flatMap((road) => [
  { id: `${road.a.id}>${road.b.id}`, road, from: road.a, to: road.b, length: road.length },
  { id: `${road.b.id}>${road.a.id}`, road, from: road.b, to: road.a, length: road.length },
])
export const edgeById = new Map(edges.map((e) => [e.id, e]))
export const outgoing = new Map(
  junctions.map((node) => [node.id, edges.filter((e) => e.from.id === node.id)]),
)
export const busLines: BusLine[] = [
  {
    id: '01',
    name: 'Север — Центр',
    color: '#38c6c1',
    nodes: ['n1_1', 'n1_2', 'n1_3', 'n2_3', 'n3_3', 'n4_3', 'n4_2', 'n4_1', 'n3_1', 'n2_1', 'n1_1'],
  },
  {
    id: '02',
    name: 'Нура — Есиль',
    color: '#edb14a',
    nodes: ['n5_0', 'n5_1', 'n5_2', 'n5_3', 'n4_3', 'n3_3', 'n3_2', 'n3_1', 'n3_0', 'n4_0', 'n5_0'],
  },
  {
    id: '03',
    name: 'Алматы — Центр',
    color: '#9d91e9',
    nodes: [
      'n1_4',
      'n1_5',
      'n1_6',
      'n2_6',
      'n2_5',
      'n3_5',
      'n4_5',
      'n4_4',
      'n4_3',
      'n3_3',
      'n2_3',
      'n1_3',
      'n1_4',
    ],
  },
]
export const tramLoops: Record<DistrictId, string[]> = {
  nura: ['n3_0', 'n3_1', 'n3_2', 'n4_2', 'n4_1', 'n4_0', 'n3_0'],
  esil: ['n3_3', 'n3_4', 'n3_5', 'n4_5', 'n4_4', 'n4_3', 'n3_3'],
  saryarka: ['n0_0', 'n0_1', 'n0_2', 'n1_2', 'n1_1', 'n1_0', 'n0_0'],
  baikonur: ['n0_2', 'n0_3', 'n0_4', 'n1_4', 'n1_3', 'n1_2', 'n0_2'],
  almaty: ['n0_4', 'n0_5', 'n0_6', 'n1_6', 'n1_5', 'n1_4', 'n0_4'],
}
export function edgesForNodes(nodes: string[]): Edge[] {
  return nodes.slice(0, -1).map((node, i) => {
    const edge = edgeById.get(`${node}>${nodes[i + 1]}`)
    if (!edge) throw new Error(`Disconnected route: ${node}>${nodes[i + 1]}`)
    return edge
  })
}
export function shortestPath(from: string, to: string): Edge[] {
  const distance = new Map([[from, 0]])
  const previous = new Map<string, Edge>()
  const unvisited = new Set(junctions.map((n) => n.id))
  while (unvisited.size) {
    const current = [...unvisited].sort(
      (a, b) => (distance.get(a) ?? Infinity) - (distance.get(b) ?? Infinity),
    )[0]
    if (current === to || !distance.has(current)) break
    unvisited.delete(current)
    for (const edge of outgoing.get(current) || []) {
      const candidate = distance.get(current)! + edge.length * (edge.road.arterial ? 0.85 : 1)
      if (candidate < (distance.get(edge.to.id) ?? Infinity)) {
        distance.set(edge.to.id, candidate)
        previous.set(edge.to.id, edge)
      }
    }
  }
  const path: Edge[] = []
  let current = to
  while (current !== from) {
    const edge = previous.get(current)
    if (!edge) return []
    path.unshift(edge)
    current = edge.from.id
  }
  return path
}
export function elevation(road: Road, t: number) {
  return road.bridge ? 0.2 + Math.min(t * 5, (1 - t) * 5, 1) * 2.6 : 0.2
}
export function pointOnEdge(edge: Edge, position: number, busLane = false) {
  const t = Math.max(0, Math.min(1, position / edge.length))
  const dx = (edge.to.x - edge.from.x) / edge.length
  const dz = (edge.to.z - edge.from.z) / edge.length
  const lane = busLane ? 4.2 : 1.8
  return {
    x: edge.from.x + dx * position - dz * lane,
    z: edge.from.z + dz * position + dx * lane,
    y: elevation(edge.road, t),
    angle: Math.atan2(dx, dz),
  }
}
