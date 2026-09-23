import { describe, expect, it } from 'vitest'
import scenario from '../../../data/scenario.json'
import type { Config, Decision } from '../types'
import { TrafficEngine } from './engine'
import { busLines, edgesForNodes, junctions, pointOnEdge, shortestPath, tramLoops } from './network'

const config = scenario as unknown as Config
const build = (decisions: Decision[] = []) => new TrafficEngine(config, decisions)

describe('deterministic traffic and passenger simulation', () => {
  it('connects all junctions and closes every public transport route', () => {
    for (const origin of junctions)
      for (const destination of junctions) {
        if (origin === destination) continue
        const path = shortestPath(origin.id, destination.id)
        expect(path[0].from.id).toBe(origin.id)
        expect(path.at(-1)!.to.id).toBe(destination.id)
        path.slice(1).forEach((edge, i) => expect(path[i].to.id).toBe(edge.from.id))
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
