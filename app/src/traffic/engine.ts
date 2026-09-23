import type { Config, Decision } from '../types'
import {
  busLines,
  districtAt,
  edgesForNodes,
  tripNodes,
  pointOnEdge,
  isSignalized,
  nodeById,
  roads,
  shortestPath,
  tramLoops,
} from './network'
import type { DistrictId, Edge, Junction } from './network'

export type Period = 'morning' | 'day' | 'evening'
export type Vehicle = {
  id: number
  kind: 'car' | 'bus' | 'tram'
  path: Edge[]
  segment: number
  position: number
  speed: number
  color: number
  dwell: number
  passengers: number
  capacity: number
  line: string
  district?: DistrictId
}
export type Stop = {
  id: string
  node: Junction
  name: string
  arrivals: number[]
  generated: number
  boarded: number
  fraction: number
}
export type RoadReading = {
  id: string
  name: string
  vehicles: number
  stopped: number
  speed: number
  congestion: number
  district: DistrictId
  bridge: boolean
}
export type TrafficSnapshot = {
  elapsed: number
  time: string
  cars: number
  completed: number
  pending: number
  flow: number
  averageSpeed: number
  waiting: number
  averageWait: number
  boarded: number
  transitShare: number
  passengerDemand: number
  buses: number
  roads: RoadReading[]
  stops: { id: string; name: string; district: DistrictId; waiting: number; wait: number }[]
}
type DistrictSettings = { t1: number; t2: number; share: number; busLane: boolean; tram: boolean }
const STARTS = { morning: 7.5 * 3600, day: 13 * 3600, evening: 17.5 * 3600 }
const PEAK = { morning: 1.35, day: 0.68, evening: 1.5 }
export const STEP = 0.2
const CAR_LENGTH = 2.8
const GAP = 1.8
const MAX_CARS = 850
const routeCache = new Map<string, Edge[]>()

// Seeded PRNG makes restarts and baseline comparisons reproducible.
export function randomSource(seed: number) {
  let value = seed >>> 0
  return () => {
    value = (1664525 * value + 1013904223) >>> 0
    return value / 4294967296
  }
}

export class TrafficEngine {
  elapsed = 0
  vehicles: Vehicle[] = []
  stops: Stop[] = []
  generatedCars = 0
  completed = 0
  pending = 0
  alighted = 0
  settings: Record<string, DistrictSettings> = {}
  smartSignals = false
  private random = randomSource(230926)
  private id = 0
  private carFraction = 0
  private accumulator = 0
  private pendingTrips: Edge[][] = []
  private stopByNode = new Map<string, Stop>()
  readonly period: Period

  constructor(config: Config, decisions: Decision[], period: Period = 'morning', warmup = 90) {
    this.period = period
    for (const district of config.districts) {
      this.settings[district.id] = {
        t1: district.indicators.T1,
        t2: district.indicators.T2,
        share: district.population_share,
        busLane: false,
        tram: false,
      }
    }
    for (const decision of decisions) {
      const measure = config.measures.find((m) => m.id === decision.measure_id)!
      const factor = (config.horizon - measure.lag) / config.horizon
      const targets =
        measure.scope === 'city' ? Object.keys(this.settings) : [decision.district_id!]
      for (const district of targets) {
        this.settings[district].t1 += (measure.effects.T1 || 0) * factor
        this.settings[district].t2 += (measure.effects.T2 || 0) * factor
        if (measure.id === 'M1') this.settings[district].busLane = true
        if (measure.id === 'M3') this.settings[district].tram = true
      }
      if (measure.id === 'M2') this.smartSignals = true
    }
    const m1 = decisions.find((d) => d.measure_id === 'M1')
    if (m1 && this.smartSignals) this.settings[m1.district_id!].t1 += 2
    const stopIds = new Set(busLines.flatMap((line) => line.stops))
    for (const [district, settings] of Object.entries(this.settings)) {
      if (settings.tram)
        tramLoops[district as DistrictId].slice(0, -1).forEach((id) => stopIds.add(id))
    }
    this.stops = [...stopIds].sort().map((id) => {
      const node = nodeById.get(id)!
      const districtName = config.districts.find((d) => d.id === node.district)!.name
      return {
        id,
        node,
        name: `${districtName} · ${node.index + 1}`,
        arrivals: [],
        generated: 0,
        boarded: 0,
        fraction: 0,
      }
    })
    this.stopByNode = new Map(this.stops.map((s) => [s.id, s]))
    for (const line of busLines) {
      const path = edgesForNodes(line.nodes)
      const extra = line.nodes.some((id) => this.settings[nodeById.get(id)!.district].busLane)
        ? 1
        : 0
      for (let i = 0; i < 3 + extra; i++)
        this.addTransit(path, 'bus', line.id, Math.floor((i * path.length) / (3 + extra)))
    }
    for (const [district, settings] of Object.entries(this.settings)) {
      if (settings.tram) {
        const path = edgesForNodes(tramLoops[district as DistrictId])
        for (let i = 0; i < 2; i++)
          this.addTransit(
            path,
            'tram',
            'LRT',
            Math.floor((i * path.length) / 2),
            district as DistrictId,
          )
      }
    }
    for (let i = 0; i < Math.round(warmup / STEP); i++) this.tick()
  }

  private addTransit(
    path: Edge[],
    kind: 'bus' | 'tram',
    line: string,
    segment: number,
    district?: DistrictId,
  ) {
    for (let attempt = 0; attempt < path.length; attempt++) {
      if (!this.vehicles.some((v) => v.path[v.segment].id === path[segment % path.length].id)) break
      segment++
    }
    this.vehicles.push({
      id: this.id++,
      kind,
      path,
      segment: segment % path.length,
      position: Math.min(12, path[segment % path.length].length - 1.5),
      speed: 0,
      color:
        kind === 'tram' ? 0xa99ae9 : line === '01' ? 0x30d4c3 : line === '02' ? 0xf3bd56 : 0xa38aef,
      dwell: 0,
      passengers: 0,
      capacity: kind === 'tram' ? 70 : 26,
      line,
      district,
    })
  }

  advance(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    this.accumulator += seconds
    while (this.accumulator + 1e-9 >= STEP) {
      this.tick()
      this.accumulator -= STEP
    }
  }

  isPriority(vehicle: Vehicle, edge = vehicle.path[vehicle.segment]) {
    return (
      vehicle.kind === 'tram' ||
      (vehicle.kind === 'bus' &&
        this.settings[districtAt((edge.from.x + edge.to.x) / 2, (edge.from.z + edge.to.z) / 2)]
          .busLane)
    )
  }

  isGreen(edge: Edge) {
    return this.signalState(edge) !== 'red'
  }

  signalState(edge: Edge): 'green' | 'amber' | 'red' {
    if (!isSignalized(edge.to)) return 'green'
    const cycle = this.smartSignals ? 30 : 46
    const phase = (this.elapsed + edge.to.index * 7) % cycle
    const tangent = pointOnEdge(edge, edge.length)
    const vertical = Math.abs(Math.cos(tangent.angle)) >= Math.abs(Math.sin(tangent.angle))
    const [start, end] = vertical
      ? [0, this.smartSignals ? 14 : 18]
      : this.smartSignals
        ? [15, 29]
        : [23, 41]
    return phase < start || phase >= end ? 'red' : phase >= end - 3 ? 'amber' : 'green'
  }

  private pickNode(weighted = false): Junction {
    if (weighted && this.random() < 0.5) {
      const candidates = tripNodes.filter(
        (n) => n.district === (this.period === 'evening' ? 'nura' : 'esil'),
      )
      return candidates[Math.floor(this.random() * candidates.length)]
    }
    const value = this.random()
    let cumulative = 0
    let district = 'esil'
    for (const [id, settings] of Object.entries(this.settings)) {
      cumulative += settings.share
      if (value <= cumulative) {
        district = id
        break
      }
    }
    const candidates = tripNodes.filter((n) => n.district === district)
    return candidates[Math.floor(this.random() * candidates.length)]
  }

  private tick() {
    this.elapsed += STEP
    const peak = PEAK[this.period]
    const transportShare = Object.values(this.settings).reduce(
      (sum, s) => sum + s.share * (0.12 + s.t2 * 0.005),
      0,
    )
    this.carFraction += STEP * 9 * peak * (1 - transportShare)
    while (this.carFraction >= 1) {
      this.carFraction--
      const from = this.pickNode()
      let to = this.pickNode(true)
      if (to.id === from.id)
        to = tripNodes[(tripNodes.findIndex((n) => n.id === from.id) + 15) % tripNodes.length]
      const key = `${from.id}>${to.id}`
      if (!routeCache.has(key)) routeCache.set(key, shortestPath(from.id, to.id))
      this.pendingTrips.push(routeCache.get(key)!)
      this.generatedCars++
    }
    // New arrivals wait outside the network if the first road is full; no cars disappear.
    const starts = new Map<string, number>()
    for (const vehicle of this.vehicles) {
      if (!this.isPriority(vehicle)) {
        const edge = vehicle.path[vehicle.segment]
        starts.set(edge.id, Math.min(starts.get(edge.id) ?? Infinity, vehicle.position))
      }
    }
    const deferred: Edge[][] = []
    let cars = this.vehicles.filter((v) => v.kind === 'car').length
    for (const path of this.pendingTrips) {
      if (cars >= MAX_CARS || (starts.get(path[0].id) ?? Infinity) < 7) {
        deferred.push(path)
        continue
      }
      const palette = [0xefebe0, 0xdee5e9, 0xb95a43, 0x52778b, 0xd6ba71, 0x49505c]
      this.vehicles.push({
        id: this.id++,
        kind: 'car',
        path,
        segment: 0,
        position: 0,
        speed: 0,
        color: palette[Math.floor(this.random() * palette.length)],
        dwell: 0,
        passengers: 0,
        capacity: 0,
        line: '',
      })
      starts.set(path[0].id, 0)
      cars++
    }
    this.pendingTrips = deferred
    this.pending = deferred.length

    for (const stop of this.stops) {
      const settings = this.settings[stop.node.district]
      const count = this.stops.filter((s) => s.node.district === stop.node.district).length
      stop.fraction += (STEP * (6 * peak * settings.share * (0.12 + settings.t2 * 0.005))) / count
      while (stop.fraction >= 1) {
        stop.fraction--
        stop.arrivals.push(this.elapsed)
        stop.generated++
      }
    }

    const groups = new Map<string, Vehicle[]>()
    const groupKey = (vehicle: Vehicle, edge = vehicle.path[vehicle.segment]) =>
      `${edge.id}:${this.isPriority(vehicle, edge) ? 'transit' : 'road'}`
    for (const vehicle of this.vehicles) {
      const key = groupKey(vehicle)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(vehicle)
    }
    const vehicleLength = (vehicle: Vehicle) =>
      vehicle.kind === 'car' ? CAR_LENGTH : vehicle.kind === 'bus' ? 6 : 10
    const entries = new Map(
      [...groups].map(([key, vehicles]) => {
        const first = vehicles.reduce((a, b) => (a.position < b.position ? a : b))
        return [key, { position: first.position, length: vehicleLength(first) }] as const
      }),
    )
    const finished = new Set<number>()
    for (const vehicles of groups.values()) {
      vehicles.sort((a, b) => b.position - a.position || a.id - b.id)
      let leaderPosition = Infinity
      let leaderLength = CAR_LENGTH
      for (const vehicle of vehicles) {
        const edge = vehicle.path[vehicle.segment]
        const settings = this.settings[edge.to.district]
        const freeSpeed = (edge.road.arterial ? 6.2 : 4.4) * (0.65 + settings.t1 / 150)
        const length = vehicleLength(vehicle)
        const previous = vehicle.position
        const priority = this.isPriority(vehicle)
        if (vehicle.dwell > 0) {
          vehicle.dwell -= STEP
          vehicle.speed = 0
        } else {
          const nextSpeed = Math.min(
            vehicle.speed + 2 * STEP,
            vehicle.kind === 'tram' ? 7 : freeSpeed,
          )
          vehicle.position = Math.max(
            previous,
            Math.min(
              previous + nextSpeed * STEP,
              leaderPosition - (leaderLength + length) / 2 - GAP,
              edge.length - 1,
            ),
          )
          vehicle.speed = (vehicle.position - previous) / STEP
        }
        const last = vehicle.segment === vehicle.path.length - 1
        if (
          vehicle.position >= edge.length - 1.1 &&
          vehicle.dwell <= 0 &&
          (priority || this.isGreen(edge) || (last && vehicle.kind === 'car'))
        ) {
          if (last && vehicle.kind === 'car') {
            finished.add(vehicle.id)
            this.completed++
            continue
          }
          const nextIndex = (vehicle.segment + 1) % vehicle.path.length
          const next = vehicle.path[nextIndex]
          const nextKey = groupKey(vehicle, next)
          const entry = entries.get(nextKey)
          if (!entry || entry.position >= (length + entry.length) / 2 + GAP) {
            const stop = this.stopByNode.get(edge.to.id)
            if (
              stop &&
              vehicle.kind !== 'car' &&
              (!vehicle.district || stop.node.district === vehicle.district)
            ) {
              const alight = Math.ceil(vehicle.passengers * 0.45)
              vehicle.passengers -= alight
              this.alighted += alight
              const board = Math.min(vehicle.capacity - vehicle.passengers, stop.arrivals.length)
              stop.arrivals.splice(0, board)
              stop.boarded += board
              vehicle.passengers += board
              vehicle.dwell = 2 + board * 0.15
            }
            vehicle.segment = nextIndex
            vehicle.position = 0
            vehicle.speed = 0
            entries.set(nextKey, { position: 0, length })
            continue
          }
        }
        leaderPosition = vehicle.position
        leaderLength = length
      }
    }
    this.vehicles = this.vehicles.filter((v) => !finished.has(v.id))
  }

  snapshot(): TrafficSnapshot {
    const cars = this.vehicles.filter((v) => v.kind === 'car')
    const totalSpeed = cars.reduce((sum, v) => sum + v.speed * 7.2, 0)
    const byRoad = new Map<string, Vehicle[]>()
    for (const car of cars) {
      const id = car.path[car.segment].road.id
      if (!byRoad.has(id)) byRoad.set(id, [])
      byRoad.get(id)!.push(car)
    }
    const readings: RoadReading[] = roads.map((road) => {
      const onRoad = byRoad.get(road.id) || []
      const stopped = onRoad.filter((v) => v.speed < 0.6).length
      const average = onRoad.length
        ? onRoad.reduce((s, v) => s + v.speed * 7.2, 0) / onRoad.length
        : 0
      return {
        id: road.id,
        name: road.name,
        vehicles: onRoad.length,
        stopped,
        speed: average,
        congestion: Math.min(
          1,
          (stopped / Math.max(4, onRoad.length)) * 0.65 +
            (onRoad.length / (road.length / 2.2)) * 0.35,
        ),
        district: districtAt((road.a.x + road.b.x) / 2, (road.a.z + road.b.z) / 2),
        bridge: road.bridge,
      }
    })
    const waiting = this.stops.reduce((sum, s) => sum + s.arrivals.length, 0)
    const totalWait = this.stops.reduce(
      (sum, s) => sum + s.arrivals.reduce((t, a) => t + this.elapsed - a, 0),
      0,
    )
    const clock = STARTS[this.period] + this.elapsed
    return {
      elapsed: this.elapsed,
      time: `${String(Math.floor(clock / 3600) % 24).padStart(2, '0')}:${String(Math.floor(clock / 60) % 60).padStart(2, '0')}`,
      cars: cars.length,
      completed: this.completed,
      pending: this.pending,
      flow: cars.length
        ? Math.round((100 * cars.filter((v) => v.speed > 0.6).length) / cars.length)
        : 100,
      averageSpeed: cars.length ? totalSpeed / cars.length : 0,
      waiting,
      averageWait: waiting ? totalWait / waiting : 0,
      boarded: this.stops.reduce((sum, s) => sum + s.boarded, 0),
      transitShare:
        Object.values(this.settings).reduce((sum, s) => sum + s.share * (0.12 + s.t2 * 0.005), 0) *
        100,
      passengerDemand:
        (this.stops.reduce((sum, s) => sum + s.generated, 0) / Math.max(1, this.elapsed)) * 60,
      buses: this.vehicles.filter((v) => v.kind !== 'car').length,
      roads: readings,
      stops: this.stops.map((s) => ({
        id: s.id,
        name: s.name,
        district: s.node.district,
        waiting: s.arrivals.length,
        wait: s.arrivals.length
          ? s.arrivals.reduce((t, a) => t + this.elapsed - a, 0) / s.arrivals.length
          : 0,
      })),
    }
  }
}
