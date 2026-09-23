import { describe, expect, it } from 'vitest'
import scenario from '../../../data/scenario.json'
import type { Config, Decision } from '../types'
import { TrafficEngine } from './engine'
import {
  busLines,
  districtAreas,
  edges,
  edgesForNodes,
  junctions,
  nearestNode,
  outgoing,
  pointOnEdge,
  pointOnRoad,
  roads,
  shortestPath,
  tramLoops,
} from './network'
import { geography, landmarks, project } from './geography'

const config = scenario as unknown as Config
const build = (decisions: Decision[] = []) => new TrafficEngine(config, decisions)

describe('deterministic traffic and passenger simulation', () => {
  it('uses curved OSM centrelines and the mapped Astana landmark axis', () => {
    expect(geography.license).toBe('ODbL-1.0')
    expect(roads.length).toBeGreaterThan(500)
    expect(roads.some((r) => r.name.includes('Кабанбай'))).toBe(true)
    const curved = roads.find(
      (r) => r.points.length > 3 && r.length > Math.hypot(r.a.x - r.b.x, r.a.z - r.b.z) + 3,
    )!
    expect(curved).toBeDefined()
    const midpoint = pointOnRoad(curved, curved.cumulative[1])
    expect(midpoint.x).toBeCloseTo(curved.points[1][0], 6)
    expect(midpoint.z).toBeCloseTo(curved.points[1][1], 6)
    for (const road of roads) {
      expect(road.length).toBeGreaterThan(3)
      for (let i = 1; i < road.cumulative.length; i++)
        expect(road.cumulative[i]).toBeGreaterThan(road.cumulative[i - 1])
    }
    const khan = landmarks.find((p) => p.id === 'khan-shatyr')!,
      bayterek = landmarks.find((p) => p.id === 'bayterek')!,
      akorda = landmarks.find((p) => p.id === 'akorda')!
    expect(khan.x).toBeLessThan(bayterek.x)
    expect(bayterek.x).toBeLessThan(akorda.x)
    expect(project(bayterek.lat, bayterek.lon)).toEqual([bayterek.x, bayterek.z])
    expect(landmarks.find((p) => p.id === 'expo')!.z).toBeGreaterThan(bayterek.z)
  })

  it('cached routing matches independent edge relaxation on the imported graph', () => {
    const origin = junctions[0].id,
      costs = new Map([[origin, 0]])
    for (let iteration = 0; iteration < junctions.length; iteration++) {
      let changed = false
      for (const edge of edges) {
        const candidate =
          (costs.get(edge.from.id) ?? Infinity) + edge.length * (edge.road.arterial ? 0.85 : 1)
        if (candidate < (costs.get(edge.to.id) ?? Infinity)) {
          costs.set(edge.to.id, candidate)
          changed = true
        }
      }
      if (!changed) break
    }
    for (const destination of junctions.filter((_, i) => i % 23 === 0)) {
      const route = shortestPath(origin, destination.id)
      expect(
        route.reduce((sum, e) => sum + e.length * (e.road.arterial ? 0.85 : 1), 0),
      ).toBeCloseTo(costs.get(destination.id)!, 6)
    }
  })
  it('connects all junctions and closes every public transport route', () => {
    const reached = new Set<string>(),
      queue = [junctions[0].id]
    while (queue.length) {
      const id = queue.pop()!
      if (reached.has(id)) continue
      reached.add(id)
      queue.push(...outgoing.get(id)!.map((e) => e.to.id))
    }
    expect(reached.size).toBe(junctions.length)
    for (const area of districtAreas) {
      const origin = nearestNode(area.lat, area.lon)
      for (const destination of junctions.filter((_, i) => i % 19 === 0)) {
        if (origin.id === destination.id) continue
        const path = shortestPath(origin.id, destination.id)
        expect(path[0].from.id).toBe(origin.id)
        expect(path.at(-1)!.to.id).toBe(destination.id)
        path.slice(1).forEach((edge, i) => expect(path[i].to.id).toBe(edge.from.id))
      }
    }
    for (const nodes of [...busLines.map((line) => line.nodes), ...Object.values(tramLoops)]) {
      const path = edgesForNodes(nodes)
      expect(path[0].from.id).toBe(path.at(-1)!.to.id)
    }
  })

  it('restarts reproducibly and advances independently of render frame rate', () => {
    const one = build(),
      two = build()
    for (let i = 0; i < 100; i++) one.advance(0.2)
    for (let i = 0; i < 20; i++) two.advance(1)
    expect(one.snapshot()).toEqual(two.snapshot())
    expect(one.vehicles).toEqual(two.vehicles)
    const before = one.snapshot()
    one.advance(0)
    one.advance(-1)
    one.advance(NaN)
    expect(one.snapshot()).toEqual(before)
  })

  it('conserves cars and passengers while queues form and buses board', () => {
    const engine = build()
    engine.advance(180)
    const snapshot = engine.snapshot()
    const generated = engine.stops.reduce((n, stop) => n + stop.generated, 0)
    const onboard = engine.vehicles.reduce((n, vehicle) => n + vehicle.passengers, 0)
    expect(engine.generatedCars).toBe(snapshot.cars + snapshot.completed + snapshot.pending)
    expect(generated).toBe(snapshot.waiting + onboard + engine.alighted)
    expect(snapshot.boarded).toBe(onboard + engine.alighted)
    expect(snapshot.completed).toBeGreaterThan(0)
    expect(snapshot.boarded).toBeGreaterThan(0)
    expect(snapshot.waiting).toBeGreaterThan(0)
    expect(snapshot.roads.some((road) => road.stopped >= 4)).toBe(true)
    expect(snapshot.roads.some((road) => road.speed > 20)).toBe(true)
    for (const vehicle of engine.vehicles) {
      expect(vehicle.passengers).toBeLessThanOrEqual(vehicle.capacity)
      expect(vehicle.position).toBeGreaterThanOrEqual(0)
      expect(vehicle.position).toBeLessThan(vehicle.path[vehicle.segment].length)
      const point = pointOnEdge(vehicle.path[vehicle.segment], vehicle.position)
      expect([point.x, point.y, point.z, vehicle.speed].every(Number.isFinite)).toBe(true)
    }
  })

  it('produces more private and public transport demand in rush hour', () => {
    const peak = new TrafficEngine(config, [], 'evening')
    const day = new TrafficEngine(config, [], 'day')
    expect(peak.generatedCars).toBeGreaterThan(day.generatedCars)
    expect(peak.snapshot().passengerDemand).toBeGreaterThan(day.snapshot().passengerDemand)
    expect(peak.snapshot().cars).toBeGreaterThan(day.snapshot().cars)
  })

  it('keeps vehicle bodies separated within each lane', () => {
    const engine = build([{ measure_id: 'M1', district_id: 'nura' }])
    for (let step = 0; step < 100; step++) {
      engine.advance(0.2)
      const lanes = new Map<string, typeof engine.vehicles>()
      for (const vehicle of engine.vehicles) {
        const key = `${vehicle.path[vehicle.segment].id}:${engine.isPriority(vehicle)}`
        if (!lanes.has(key)) lanes.set(key, [])
        lanes.get(key)!.push(vehicle)
      }
      for (const lane of lanes.values()) {
        lane.sort((a, b) => a.position - b.position)
        for (let i = 1; i < lane.length; i++) {
          const length = (kind: string) => (kind === 'car' ? 2.8 : kind === 'bus' ? 6 : 10)
          const requiredGap = (length(lane[i].kind) + length(lane[i - 1].kind)) / 2
          expect(lane[i].position - lane[i - 1].position).toBeGreaterThanOrEqual(requiredGap)
        }
      }
    }
  })

  it('bus lanes change transit supply and reduce private car demand', () => {
    const base = build()
    const plan = build([
      { measure_id: 'M1', district_id: 'nura' },
      { measure_id: 'M2', district_id: null },
    ])
    base.advance(120)
    plan.advance(120)
    expect(plan.snapshot().buses).toBeGreaterThan(base.snapshot().buses)
    expect(plan.generatedCars).toBeLessThan(base.generatedCars)
    expect(plan.snapshot().transitShare).toBeGreaterThan(base.snapshot().transitShare)
    expect(plan.snapshot().boarded).toBeGreaterThan(base.snapshot().boarded)
    expect(plan.snapshot().roads).not.toEqual(base.snapshot().roads)
  })

  it('LRT carries passengers on a separate district route', () => {
    const base = build()
    const plan = build([{ measure_id: 'M3', district_id: 'nura' }])
    plan.advance(120)
    const trains = plan.vehicles.filter((vehicle) => vehicle.kind === 'tram')
    expect(trains).toHaveLength(2)
    expect(trains.some((vehicle) => vehicle.passengers > 0)).toBe(true)
    expect(plan.snapshot().buses).toBe(base.snapshot().buses + 2)
    expect(plan.snapshot().transitShare).toBeGreaterThan(base.snapshot().transitShare)
  })

  it('changing measure order leaves traffic unchanged; unrelated measures preserve the baseline', () => {
    const decisions: Decision[] = [
      { measure_id: 'M1', district_id: 'nura' },
      { measure_id: 'M2', district_id: null },
    ]
    expect(build(decisions).snapshot()).toEqual(build([...decisions].reverse()).snapshot())
    expect(build(config.example).snapshot()).toEqual(build().snapshot())
  })
})
