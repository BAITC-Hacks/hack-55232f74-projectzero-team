import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  cityBounds,
  distanceToSegment,
  geography,
  landmarks,
  nearWater,
  pointInPolygon,
  project,
} from './geography'
import type { Point } from './geography'
import { districtAt, elevation, pointOnRoad, roads } from './network'
import type { Road } from './network'
import { randomSource } from './engine'

export function strip(points: Point[], width: number, y: number, offset = 0) {
  const vertices: number[] = [],
    indices: number[] = []
  points.forEach((p, i) => {
    const before = points[Math.max(0, i - 1)],
      after = points[Math.min(points.length - 1, i + 1)]
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1
    const dx = (after[0] - before[0]) / length,
      dz = (after[1] - before[1]) / length
    for (const side of [-1, 1])
      vertices.push(
        p[0] - dz * (offset + (side * width) / 2),
        y,
        p[1] + dx * (offset + (side * width) / 2),
      )
    if (i < points.length - 1) {
      const j = i * 2
      indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2)
    }
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
export function ribbon(road: Road, width: number, offset = 0, lift = 0) {
  const distances = [...road.cumulative]
  if (road.bridge) for (let i = 1; i < 10; i++) distances.push((road.length * i) / 10)
  distances.sort((a, b) => a - b)
  const points = distances.map((d) => pointOnRoad(road, d)),
    geometry = strip(
      points.map((p) => [p.x, p.z]),
      width,
      0,
      offset,
    )
  const position = geometry.getAttribute('position')
  distances.forEach((d, i) => {
    position.setY(i * 2, elevation(road, d / road.length) + lift)
    position.setY(i * 2 + 1, elevation(road, d / road.length) + lift)
  })
  geometry.computeVertexNormals()
  return geometry
}
export function merge(parts: THREE.BufferGeometry[]) {
  if (!parts.length) return new THREE.BufferGeometry()
  const result = mergeGeometries(parts, false)!
  parts.forEach((part) => part.dispose())
  return result
}
const groundMaterial = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.95 })
const shapeGeometry = (points: Point[]) =>
  new THREE.ShapeGeometry(new THREE.Shape(points.map((p) => new THREE.Vector2(p[0], -p[1]))))
const polygon = (points: Point[], height: number, color: string) => {
  const mesh = new THREE.Mesh(shapeGeometry(points), groundMaterial(color))
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = height
  mesh.receiveShadow = true
  return mesh
}
const civicAxis: Point[] = [
  landmarks[1],
  { x: project(51.1301, 71.4175)[0], z: project(51.1301, 71.4175)[1] },
  landmarks[0],
  landmarks[2],
].map((p) => [p.x, p.z])
const parks: Point[][] = [
  [
    [51.157, 71.398],
    [51.158, 71.41],
    [51.153, 71.418],
    [51.1465, 71.413],
    [51.149, 71.401],
  ],
  [
    [51.132, 71.45],
    [51.133, 71.459],
    [51.123, 71.466],
    [51.117, 71.459],
    [51.119, 71.451],
  ],
].map((points) => points.map(([lat, lon]) => project(lat, lon)))

export function buildTerrain() {
  const group = new THREE.Group()
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3100, 3100), groundMaterial('#bbbfa9'))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.5
  ground.receiveShadow = true
  group.add(ground)
  group.add(
    polygon(
      [
        [cityBounds.minX - 20, cityBounds.minZ - 20],
        [cityBounds.maxX + 20, cityBounds.minZ - 20],
        [cityBounds.maxX + 20, cityBounds.maxZ + 20],
        [cityBounds.minX - 20, cityBounds.maxZ + 20],
      ],
      -0.4,
      '#c8cabd',
    ),
  )
  for (const park of parks) group.add(polygon(park, -0.25, '#94b28d'))
  for (const park of geography.parks) group.add(polygon(park.points as Point[], -0.24, '#94b28d'))
  for (const river of geography.rivers) {
    group.add(
      new THREE.Mesh(
        strip(river.points as Point[], river.width + 5, -0.15),
        groundMaterial('#ddd6be'),
      ),
    )
    group.add(
      new THREE.Mesh(
        strip(river.points as Point[], river.width, -0.05),
        new THREE.MeshStandardMaterial({ color: '#74b0b5', roughness: 0.28, metalness: 0.15 }),
      ),
    )
    for (const side of [-1, 1])
      group.add(
        new THREE.Mesh(
          strip(river.points as Point[], 1.4, 0.03, side * (river.width / 2 + 1.5)),
          groundMaterial('#e9dfc9'),
        ),
      )
  }
  group.add(new THREE.Mesh(strip(civicAxis, 28, -0.22), groundMaterial('#99b582')))
  group.add(new THREE.Mesh(strip(civicAxis, 10, 0.03), groundMaterial('#e0d5ba')))
  // Nurzhol's pools and parterres are stylized around its actual urban axis.
  for (let i = 1; i < civicAxis.length; i++) {
    const a = civicAxis[i - 1],
      b = civicAxis[i],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz)
    for (let d = 24; d < length - 18; d += 35) {
      const x = a[0] + (dx * d) / length,
        z = a[1] + (dz * d) / length
      if (landmarks.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + 8)) continue
      const pool = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.25, 14), groundMaterial('#6bb7bb'))
      pool.position.set(x, 0.15, z)
      pool.rotation.y = Math.atan2(dx, dz)
      group.add(pool)
    }
  }
  return group
}
export function makeFacade() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#f0ece1'
  ctx.fillRect(0, 0, 128, 256)
  for (let y = 5; y < 252; y += 16)
    for (let x = 6; x < 125; x += 18) {
      ctx.fillStyle = '#73909a'
      ctx.fillRect(x, y, 9, 10)
      ctx.fillStyle = '#b8cbd1'
      ctx.fillRect(x, y, 8, 2)
    }
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  // InstancedMesh applies instanceColor automatically; vertexColors would require
  // a separate geometry attribute and otherwise turn the facades black.
  return new THREE.MeshStandardMaterial({ map, roughness: 0.65 })
}
export function buildBlocks(facade: THREE.MeshStandardMaterial) {
  const random = randomSource(193),
    group = new THREE.Group(),
    dummy = new THREE.Object3D()
  const candidates: {
      x: number
      z: number
      w: number
      d: number
      h: number
      angle: number
      color: string
    }[] = [],
    trees: { x: number; z: number; size: number }[] = []
  const occupied = new Map<string, { x: number; z: number; r: number }[]>(),
    segmentGrid = new Map<string, [Point, Point][]>()
  for (const road of roads)
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1],
        b = road.points[i]
      for (
        let x = Math.floor((Math.min(a[0], b[0]) - 15) / 40);
        x <= Math.floor((Math.max(a[0], b[0]) + 15) / 40);
        x++
      )
        for (
          let z = Math.floor((Math.min(a[1], b[1]) - 15) / 40);
          z <= Math.floor((Math.max(a[1], b[1]) + 15) / 40);
          z++
        ) {
          const key = `${x}:${z}`
          if (!segmentGrid.has(key)) segmentGrid.set(key, [])
          segmentGrid.get(key)!.push([a, b])
        }
    }
  const nearRoad = (x: number, z: number, r: number) =>
    segmentGrid
      .get(`${Math.floor(x / 40)}:${Math.floor(z / 40)}`)
      ?.some(([a, b]) => distanceToSegment([x, z], a, b) < r) || false
  const inPark = (x: number, z: number) =>
    parks.some((p) => pointInPolygon([x, z], p)) ||
    geography.parks.some((p) => pointInPolygon([x, z], p.points))
  const inAxis = (x: number, z: number) =>
    civicAxis.slice(1).some((p, i) => distanceToSegment([x, z], civicAxis[i], p) < 17)
  const reserved = (x: number, z: number, r = 0) =>
    nearWater(x, z, r + 3) ||
    inPark(x, z) ||
    inAxis(x, z) ||
    landmarks.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + r + 3)
  const available = (x: number, z: number, r: number) => {
    if (
      x < cityBounds.minX ||
      x > cityBounds.maxX ||
      z < cityBounds.minZ ||
      z > cityBounds.maxZ ||
      reserved(x, z, r) ||
      nearRoad(x, z, r + 6.4)
    )
      return false
    const gx = Math.floor(x / 25),
      gz = Math.floor(z / 25)
    for (let a = gx - 1; a <= gx + 1; a++)
      for (let b = gz - 1; b <= gz + 1; b++)
        if (occupied.get(`${a}:${b}`)?.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r + 1.5))
          return false
    const key = `${gx}:${gz}`
    if (!occupied.has(key)) occupied.set(key, [])
    occupied.get(key)!.push({ x, z, r })
    return true
  }
  const palette = ['#d8c9b0', '#e5d8bf', '#d5d5c8', '#b6c4c6', '#d1bca7', '#e7dfce']
  for (const road of roads) {
    if (road.bridge) continue
    for (let d = 9; d < road.length - 8; d += 17 + random() * 8)
      for (const side of [-1, 1]) {
        const p = pointOnRoad(road, d, side * (13 + random() * 13)),
          w = 6 + random() * 6,
          depth = 6 + random() * 5,
          r = Math.hypot(w, depth) / 2
        if (!available(p.x, p.z, r)) continue
        const district = districtAt(p.x, p.z),
          modern = district === 'esil' || district === 'nura'
        const height = modern
          ? random() > 0.78
            ? 25 + random() * 35
            : 9 + random() * 16
          : 4 + random() * 11
        candidates.push({
          x: p.x,
          z: p.z,
          w,
          d: depth,
          h: height,
          angle: p.angle,
          color: modern && height > 25 ? '#87a8af' : palette[Math.floor(random() * palette.length)],
        })
        if (random() > 0.4)
          trees.push({
            x: p.x + Math.cos(p.angle) * (w / 2 + 2),
            z: p.z - Math.sin(p.angle) * (w / 2 + 2),
            size: 1.3 + random() * 1.2,
          })
      }
  }
  for (let i = 0; i < 2100; i++) {
    const x = cityBounds.minX + random() * (cityBounds.maxX - cityBounds.minX),
      z = cityBounds.minZ + random() * (cityBounds.maxZ - cityBounds.minZ)
    if (
      (inPark(x, z) || inAxis(x, z)) &&
      !nearWater(x, z, 3) &&
      !nearRoad(x, z, 6) &&
      !landmarks.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + 2)
    )
      trees.push({ x, z, size: 1.8 + random() * 1.7 })
  }
  const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), facade, candidates.length)
  const roofs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    groundMaterial('#d3d3c7'),
    candidates.length,
  )
  candidates.forEach((b, i) => {
    dummy.position.set(b.x, b.h / 2, b.z)
    dummy.rotation.set(0, b.angle, 0)
    dummy.scale.set(b.w, b.h, b.d)
    dummy.updateMatrix()
    bodies.setMatrixAt(i, dummy.matrix)
    bodies.setColorAt(i, new THREE.Color(b.color))
    dummy.position.y = b.h + 0.3
    dummy.scale.set(b.w + 0.2, 0.6, b.d + 0.2)
    dummy.updateMatrix()
    roofs.setMatrixAt(i, dummy.matrix)
  })
  bodies.castShadow = bodies.receiveShadow = roofs.receiveShadow = true
  group.add(bodies, roofs)
  const foliage = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    groundMaterial('#688b63'),
    trees.length,
  )
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.18, 0.24, 2, 4),
    groundMaterial('#736b51'),
    trees.length,
  )
  trees.forEach((t, i) => {
    dummy.position.set(t.x, t.size + 1, t.z)
    dummy.rotation.set(0, random() * Math.PI, 0)
    dummy.scale.set(t.size, t.size * 1.4, t.size)
    dummy.updateMatrix()
    foliage.setMatrixAt(i, dummy.matrix)
    foliage.setColorAt(
      i,
      new THREE.Color().setHSL(0.24 + random() * 0.07, 0.2, 0.43 + random() * 0.15),
    )
    dummy.position.y = 1
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    trunks.setMatrixAt(i, dummy.matrix)
  })
  foliage.castShadow = true
  group.add(foliage, trunks)
  return { group, buildingCount: candidates.length }
}
