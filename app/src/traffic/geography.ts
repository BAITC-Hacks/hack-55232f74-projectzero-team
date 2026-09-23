import data from './data/astana.json'

export type Point = [number, number]
export type GeoBuilding = {
  id: number
  name: string
  points: number[][]
  height: number
  heightSource: string
}
export type GeoPark = { id: number; name: string; points: number[][] }
export const geography = data as Omit<typeof data, 'buildings' | 'parks'> & {
  buildings: GeoBuilding[]
  parks: GeoPark[]
}
export const project = (lat: number, lon: number): Point => [
  ((lon - data.origin[1]) * 111320 * Math.cos((data.origin[0] * Math.PI) / 180)) /
    data.metresPerUnit,
  ((data.origin[0] - lat) * 111320) / data.metresPerUnit,
]
export const unproject = (x: number, z: number): Point => [
  data.origin[0] - (z * data.metresPerUnit) / 111320,
  data.origin[1] + (x * data.metresPerUnit) / (111320 * Math.cos((data.origin[0] * Math.PI) / 180)),
]
const northwest = project(data.bounds[2], data.bounds[1]),
  southeast = project(data.bounds[0], data.bounds[3])
export const cityBounds = {
  minX: northwest[0],
  minZ: northwest[1],
  maxX: southeast[0],
  maxZ: southeast[1],
}
export const landmarks = [
  { id: 'bayterek', name: 'Байтерек', lat: 51.1282863, lon: 71.4304556, height: 40, radius: 12 },
  {
    id: 'khan-shatyr',
    name: 'Хан Шатыр',
    lat: 51.1325048,
    lon: 71.4038607,
    height: 55,
    radius: 32,
  },
  { id: 'akorda', name: 'Акорда', lat: 51.1257966, lon: 71.4463507, height: 30, radius: 25 },
  {
    id: 'palace',
    name: 'Дворец мира и согласия',
    lat: 51.123123,
    lon: 71.4634559,
    height: 32,
    radius: 26,
  },
  { id: 'expo', name: 'EXPO · Нур Алем', lat: 51.0895, lon: 71.4161, height: 35, radius: 51 },
  { id: 'opera', name: 'Астана Опера', lat: 51.1354596, lon: 71.4106592, height: 23, radius: 31 },
  { id: 'mosque', name: 'Хазрет Султан', lat: 51.1254495, lon: 71.4721422, height: 37, radius: 32 },
].map((landmark) => {
  const [x, z] = project(landmark.lat, landmark.lon)
  return { ...landmark, x, z }
})
export type Landmark = (typeof landmarks)[number]

export function distanceToSegment(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    squared = dx * dx + dz * dz
  const t = squared
    ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / squared))
    : 0
  return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dz * t)
}
export function pointInPolygon(point: Point, polygon: number[][]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j]
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside
  }
  return inside
}
export function nearWater(x: number, z: number, margin = 0) {
  return data.rivers.some((river) =>
    river.points
      .slice(1)
      .some(
        (p, i) =>
          distanceToSegment([x, z], river.points[i] as Point, p as Point) <
          river.width / 2 + margin,
      ),
  )
}
