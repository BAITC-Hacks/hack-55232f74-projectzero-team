import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Config, Decision } from '../types'
import {
  districtAreas,
  districtAt,
  edges,
  isSignalized,
  pointOnEdge,
  pointOnRoad,
  roadWidth,
  roads,
} from './network'
import type { DistrictId } from './network'
import type { TrafficEngine, TrafficSnapshot } from './engine'
import { cityBounds, landmarks } from './geography'
import { buildBlocks, buildTerrain, makeFacade, merge, ribbon } from './cityScene'
import { buildLandmark } from './landmarks'

export type CityLayer = 'city' | 'traffic' | 'transit' | 'districts'
const dummy = new THREE.Object3D()
// Lit and dimmed lamp colours for the red, amber and green sections of each signal head.
const lamps = [
  ['#ff4b3a', '#3d1f1c'],
  ['#ffc23a', '#3b321c'],
  ['#44f08f', '#1b3526'],
].map((pair) => pair.map((c) => new THREE.Color(c)))
const lampState = { red: 0, amber: 1, green: 2 } as const
const roadColor = (n: number) => (n > 0.65 ? '#f07354' : n > 0.35 ? '#edc35a' : '#63cba0')
type SurfaceRange = { id: string; start: number; count: number }

export class CityRenderer {
  private scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private observer: ResizeObserver
  private ambient = new THREE.HemisphereLight(0xdce8eb, 0x8b9d76, 2)
  private sunlight = new THREE.DirectionalLight(0xffe9cf, 2.8)
  private surface!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  private ranges: SurfaceRange[] = []
  private laneMeshes: { mesh: THREE.Mesh; district: DistrictId }[] = []
  private routeMesh: THREE.Mesh | null = null
  private signalLamps: THREE.InstancedMesh[] = []
  // One signal per approach to a real crossing, skipping stubs too short to hold a pole.
  private signalEdges = edges.filter((edge) => isSignalized(edge.to) && edge.length > 8)
  private stopMeshes: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = []
  private projectGroup = new THREE.Group()
  private cars: THREE.InstancedMesh
  private cabins: THREE.InstancedMesh
  private busMeshes: THREE.Mesh[] = []
  private labels: HTMLButtonElement[] = []
  private landmarkLabels: HTMLButtonElement[] = []
  private buildingMaterial: THREE.MeshStandardMaterial
  private districtPlanes: THREE.Mesh[] = []
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private pointerStart = { x: 0, y: 0 }
  private layer: CityLayer = 'city'
  private selected = 'nura'
  private selectedRoad: string | null = null
  private projectKey = ''
  private disposed = false
  private night = false
  private home = new THREE.Vector3(490, 670, 750)
  private projected = new THREE.Vector3()
  private lastFrame = ''
  private lastEngine: TrafficEngine | null = null
  private lastRoadSnapshot: TrafficSnapshot | null = null
  private lastRoadStyle = ''
  private focusedLandmark = ''

  constructor(
    private container: HTMLElement,
    private config: Config,
    private onSelect: (district: string, road?: string) => void,
    private onFocus?: (id: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    const gl = this.renderer.getContext(),
      debug = gl.getExtension('WEBGL_debug_renderer_info')
    if (
      debug &&
      /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)))
    ) {
      this.renderer.setPixelRatio(1)
      this.renderer.shadowMap.enabled = false
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.domElement.setAttribute('aria-label', 'Интерактивный трёхмерный город')
    this.renderer.domElement.dataset.renderer = 'webgl'
    container.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color('#bacdd0')
    this.scene.fog = new THREE.Fog('#bacdd0', 1700, 3800)
    this.camera = new THREE.PerspectiveCamera(43, 1, 8, 6000)
    this.camera.position.copy(this.home)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(-30, 0, -20)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 70
    this.controls.maxDistance = 2550
    this.controls.minPolarAngle = 0.12
    this.controls.maxPolarAngle = Math.PI / 2.25
    this.controls.maxTargetRadius = 1150
    this.controls.screenSpacePanning = false
    this.sunlight.position.set(-600, 1200, -700)
    this.sunlight.castShadow = true
    this.sunlight.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sunlight.shadow.camera, {
      left: -1100,
      right: 1100,
      top: 1000,
      bottom: -1000,
      near: 10,
      far: 3000,
    })
    this.sunlight.shadow.bias = -0.0003
    this.scene.add(this.ambient, this.sunlight, buildTerrain())
    this.buildRoads()
    this.buildingMaterial = makeFacade()
    const blocks = buildBlocks(this.buildingMaterial)
    this.scene.add(blocks.group)
    this.renderer.domElement.dataset.buildings = String(blocks.buildingCount)
    for (const site of landmarks) {
      this.scene.add(buildLandmark(site))
      const label = document.createElement('button')
      label.className = 'world-landmark-label'
      label.textContent = site.name
      label.setAttribute('aria-label', `Приблизить ${site.name}`)
      label.onclick = () => this.focusLandmark(site.id)
      container.appendChild(label)
      this.landmarkLabels.push(label)
    }
    this.scene.add(this.projectGroup)
    this.cars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.5, 1.05, 2.8),
      new THREE.MeshStandardMaterial({ roughness: 0.4 }),
      1000,
    )
    this.cabins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.25, 0.7, 1.5),
      new THREE.MeshStandardMaterial({ color: '#58717d', roughness: 0.3 }),
      1000,
    )
    this.cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cars.frustumCulled = this.cabins.frustumCulled = false
    this.scene.add(this.cars, this.cabins)
    for (const area of districtAreas) {
      const label = document.createElement('button')
      label.className = 'world-district-label'
      label.textContent = area.name
      label.setAttribute('aria-label', `Выбрать район ${area.name} в городе`)
      label.title = 'Условная зона расчёта, не административная граница'
      label.onclick = () => this.onSelect(area.id)
      container.appendChild(label)
      this.labels.push(label)
      const plane = new THREE.Mesh(
        new THREE.CircleGeometry(145, 48),
        new THREE.MeshBasicMaterial({
          color: area.color,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
      )
      plane.rotation.x = -Math.PI / 2
      plane.position.set(area.x, 0.08, area.z)
      this.scene.add(plane)
      this.districtPlanes.push(plane)
    }
    this.renderer.domElement.addEventListener('pointerdown', this.down)
    this.renderer.domElement.addEventListener('pointerup', this.up)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
  }
  private material(color: string) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
  }
  private buildRoads() {
    const surfaces: THREE.BufferGeometry[] = [],
      sidewalks: THREE.BufferGeometry[] = [],
      rails: THREE.BufferGeometry[] = []
    const lanes = new Map<DistrictId, THREE.BufferGeometry[]>(),
      marks: { x: number; y: number; z: number; angle: number }[] = []
    let start = 0
    for (const road of roads) {
      const width = road.arterial ? 9 : 7.8
      sidewalks.push(ribbon(road, width + 2.2))
      const geometry = ribbon(road, width, 0, 0.05).toNonIndexed(),
        count = geometry.getAttribute('position').count
      geometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3),
      )
      this.ranges.push({ id: road.id, start, count })
      start += count
      surfaces.push(geometry)
      for (let distance = 7; distance < road.length - 7; distance += 10)
        marks.push(pointOnRoad(road, distance))
      const midpoint = pointOnRoad(road, road.length / 2),
        district = districtAt(midpoint.x, midpoint.z)
      if (!lanes.has(district)) lanes.set(district, [])
      for (const offset of [-3.2, 3.2]) lanes.get(district)!.push(ribbon(road, 1.4, offset, 0.11))
      if (road.bridge)
        for (const offset of [-width / 2 - 0.4, width / 2 + 0.4])
          rails.push(ribbon(road, 0.35, offset, 1.2))
    }
    this.surface = new THREE.Mesh(
      merge(surfaces),
      new THREE.MeshStandardMaterial({ color: '#586168', roughness: 0.95, vertexColors: true }),
    )
    this.surface.receiveShadow = true
    const sidewalksMesh = new THREE.Mesh(merge(sidewalks), this.material('#d3d2c5'))
    sidewalksMesh.receiveShadow = true
    this.scene.add(
      sidewalksMesh,
      this.surface,
      new THREE.Mesh(merge(rails), this.material('#e2ded0')),
    )
    for (const [district, parts] of lanes) {
      const mesh = new THREE.Mesh(
        merge(parts),
        new THREE.MeshBasicMaterial({ color: '#36c8bc', transparent: true, opacity: 0.7 }),
      )
      mesh.visible = false
      this.scene.add(mesh)
      this.laneMeshes.push({ mesh, district })
    }
    const markings = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.22, 3.5),
      new THREE.MeshBasicMaterial({ color: '#e8e2c8' }),
      marks.length,
    )
    marks.forEach((p, i) => {
      dummy.position.set(p.x, p.y + 0.09, p.z)
      dummy.rotation.set(-Math.PI / 2, 0, -p.angle)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      markings.setMatrixAt(i, dummy.matrix)
    })
    this.scene.add(markings)
    const count = this.signalEdges.length,
      dark = this.material('#2f3834')
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.2, 1, 6), dark, count),
      arms = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.16, 0.16), dark, count),
      heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.85, 2.3, 0.5), dark, count)
    this.signalLamps = lamps.map(
      () =>
        new THREE.InstancedMesh(
          new THREE.CircleGeometry(0.3, 10),
          new THREE.MeshBasicMaterial({ toneMapped: false }),
          count,
        ),
    )
    this.signalEdges.forEach((edge, i) => {
      // Pole on the right kerb before the crossing; mast arm holds the head over the lanes.
      const width = roadWidth(edge.road),
        at = Math.max(edge.length * 0.5, edge.length - width / 2 - 2),
        kerb = pointOnEdge(edge, at, false, width / 2 + 0.7),
        lane = pointOnEdge(edge, at, false, width / 4),
        top = kerb.y + 5.4
      dummy.rotation.set(0, 0, 0)
      dummy.position.set(kerb.x, kerb.y + 2.7, kerb.z)
      dummy.scale.set(1, 5.4, 1)
      dummy.updateMatrix()
      poles.setMatrixAt(i, dummy.matrix)
      dummy.position.set((kerb.x + lane.x) / 2, top, (kerb.z + lane.z) / 2)
      dummy.rotation.set(0, kerb.angle, 0)
      dummy.scale.set(Math.hypot(kerb.x - lane.x, kerb.z - lane.z) + 0.2, 1, 1)
      dummy.updateMatrix()
      arms.setMatrixAt(i, dummy.matrix)
      dummy.position.set(lane.x, top - 1.1, lane.z)
      dummy.rotation.set(0, kerb.angle + Math.PI, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      heads.setMatrixAt(i, dummy.matrix)
      this.signalLamps.forEach((mesh, section) => {
        dummy.position.set(lane.x, top - 1.1, lane.z)
        dummy.rotation.set(0, kerb.angle + Math.PI, 0)
        dummy.translateZ(0.26)
        dummy.translateY(0.72 - section * 0.72)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        mesh.setColorAt(i, lamps[section][1])
      })
    })
    this.scene.add(poles, arms, heads, ...this.signalLamps)
  }
  setOptions(layer: CityLayer, selected: string, night: boolean, selectedRoad: string | null) {
    this.layer = layer
    this.selected = selected
    this.selectedRoad = selectedRoad
    if (night !== this.night) {
      this.night = night
      this.scene.background = new THREE.Color(night ? '#34485b' : '#bacdd0')
      this.scene.fog = new THREE.Fog(night ? '#34485b' : '#bacdd0', 1700, 3800)
      this.ambient.intensity = night ? 0.75 : 2
      this.sunlight.intensity = night ? 0.65 : 2.8
      this.buildingMaterial.emissive.set(night ? '#544327' : '#000000')
      this.buildingMaterial.emissiveIntensity = night ? 0.32 : 0
    }
  }
  private focus(x: number, z: number, distance: number) {
    const offset = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize()
      .multiplyScalar(distance)
    this.controls.target.set(x, 0, z)
    this.camera.position.copy(this.controls.target).add(offset)
    this.lastFrame = ''
  }
  focusDistrict(id: string) {
    const area = districtAreas.find((d) => d.id === id)
    if (area) {
      this.focusedLandmark = ''
      this.focus(area.x, area.z, 520)
    }
  }
  focusLandmark(id: string) {
    const site = landmarks.find((l) => l.id === id)
    if (site) {
      this.focusedLandmark = id
      this.onFocus?.(id)
      this.focus(site.x, site.z, site.id === 'expo' ? 300 : 240)
    }
  }
  resetCamera() {
    this.focusedLandmark = ''
    this.onFocus?.('overview')
    this.camera.position.set(750, 1150, 1550)
    this.controls.target.set(30, 0, 40)
    this.lastFrame = ''
  }
  centreCamera() {
    this.focusedLandmark = ''
    this.onFocus?.('centre')
    this.camera.position.copy(this.home)
    this.controls.target.set(-30, 0, -20)
    this.lastFrame = ''
  }
  zoom(inward: boolean) {
    const offset = this.camera.position
      .clone()
      .sub(this.controls.target)
      .multiplyScalar(inward ? 0.8 : 1.25)
    offset.clampLength(70, 2550)
    this.camera.position.copy(this.controls.target).add(offset)
  }
  private updateProjects(decisions: Decision[], engine: TrafficEngine) {
    const key = JSON.stringify(decisions)
    if (key === this.projectKey) return
    this.projectKey = key
    this.projectGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.Material).dispose()
      }
    })
    this.projectGroup.clear()
    if (this.routeMesh) {
      this.scene.remove(this.routeMesh)
      this.routeMesh.geometry.dispose()
      ;(this.routeMesh.material as THREE.Material).dispose()
    }
    const used = new Set(
      engine.vehicles.filter((v) => v.kind !== 'car').flatMap((v) => v.path.map((e) => e.road.id)),
    )
    this.routeMesh = new THREE.Mesh(
      merge(roads.filter((r) => used.has(r.id)).map((r) => ribbon(r, 0.8, -3.8, 0.15))),
      new THREE.MeshBasicMaterial({ color: '#32d9db' }),
    )
    this.scene.add(this.routeMesh)
    decisions.forEach((decision, i) => {
      const measure = this.config.measures.find((m) => m.id === decision.measure_id)!,
        area = districtAreas.find((d) => d.id === decision.district_id) || districtAreas[1],
        color = this.config.categories.find((c) => c.id === measure.category)!.color
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(9, 10.5, 24),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(area.x + i * 8, 0.5, area.z)
      this.projectGroup.add(ring)
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 24, 5),
        new THREE.MeshBasicMaterial({ color }),
      )
      beacon.position.set(area.x + i * 8, 12, area.z)
      this.projectGroup.add(beacon)
    })
    for (const lane of this.laneMeshes) lane.mesh.visible = engine.settings[lane.district].busLane
    const rails = new Set(
      engine.vehicles.filter((v) => v.kind === 'tram').flatMap((v) => v.path.map((e) => e.road)),
    )
    if (rails.size)
      this.projectGroup.add(
        new THREE.Mesh(
          merge(
            [...rails].flatMap((r) => [-3.6, -2.8, 2.8, 3.6].map((o) => ribbon(r, 0.18, o, 0.14))),
          ),
          this.material('#d6ccde'),
        ),
      )
  }
  draw(engine: TrafficEngine, snapshot: TrafficSnapshot, decisions: Decision[]) {
    if (this.disposed) return
    const changed = this.controls.update(),
      frame = `${engine.elapsed}:${this.layer}:${this.selected}:${this.night}:${this.selectedRoad}:${JSON.stringify(decisions)}`
    if (!changed && frame === this.lastFrame && engine === this.lastEngine) return
    this.lastFrame = frame
    this.lastEngine = engine
    this.updateProjects(decisions, engine)
    this.signalEdges.forEach((edge, i) => {
      const lit = lampState[engine.signalState(edge)]
      this.signalLamps.forEach((mesh, section) =>
        mesh.setColorAt(i, lamps[section][section === lit ? 0 : 1]),
      )
    })
    for (const mesh of this.signalLamps)
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    const roadStyle = `${this.layer}:${this.selectedRoad}`
    if (snapshot !== this.lastRoadSnapshot || roadStyle !== this.lastRoadStyle) {
      const readings = new Map(snapshot.roads.map((r) => [r.id, r])),
        colors = this.surface.geometry.getAttribute('color'),
        color = new THREE.Color()
      for (const range of this.ranges) {
        color.set(
          this.layer === 'traffic'
            ? roadColor(readings.get(range.id)!.congestion)
            : range.id === this.selectedRoad
              ? '#91b7bf'
              : '#ffffff',
        )
        for (let i = range.start; i < range.start + range.count; i++)
          colors.setXYZ(i, color.r, color.g, color.b)
      }
      this.surface.material.color.set(this.layer === 'traffic' ? '#ffffff' : '#586168')
      colors.needsUpdate = true
      this.lastRoadSnapshot = snapshot
      this.lastRoadStyle = roadStyle
    }
    this.districtPlanes.forEach((p) => (p.visible = this.layer === 'districts'))
    if (this.routeMesh) this.routeMesh.visible = this.layer === 'transit'
    let carIndex = 0,
      busIndex = 0
    for (const vehicle of engine.vehicles) {
      const p = pointOnEdge(
        vehicle.path[vehicle.segment],
        vehicle.position,
        engine.isPriority(vehicle),
      )
      if (vehicle.kind === 'car') {
        dummy.position.set(p.x, p.y + 0.75, p.z)
        dummy.rotation.set(0, p.angle, 0)
        dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        this.cars.setMatrixAt(carIndex, dummy.matrix)
        this.cars.setColorAt(carIndex, new THREE.Color(vehicle.color))
        dummy.position.y += 0.65
        dummy.updateMatrix()
        this.cabins.setMatrixAt(carIndex++, dummy.matrix)
      } else {
        if (!this.busMeshes[busIndex]) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(2, 2, 1),
            new THREE.MeshStandardMaterial({ roughness: 0.4 }),
          )
          const window = new THREE.Mesh(
            new THREE.BoxGeometry(2.05, 0.7, 0.82),
            this.material('#344959'),
          )
          window.position.y = 0.3
          mesh.add(window)
          this.busMeshes.push(mesh)
          this.scene.add(mesh)
        }
        const mesh = this.busMeshes[busIndex++]
        mesh.visible = true
        mesh.position.set(p.x, p.y + 1.25, p.z)
        mesh.rotation.y = p.angle
        mesh.scale.z = vehicle.kind === 'tram' ? 10 : 6
        ;(mesh.material as THREE.MeshStandardMaterial).color.set(vehicle.color)
      }
    }
    for (let i = busIndex; i < this.busMeshes.length; i++) this.busMeshes[i].visible = false
    this.cars.count = this.cabins.count = carIndex
    this.cars.instanceMatrix.needsUpdate = this.cabins.instanceMatrix.needsUpdate = true
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true
    engine.stops.forEach((stop, i) => {
      if (!this.stopMeshes[i]) {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(2, 2, 1, 8),
          new THREE.MeshBasicMaterial({ color: '#50d4cc' }),
        )
        this.stopMeshes.push(mesh)
        this.scene.add(mesh)
      }
      const mesh = this.stopMeshes[i],
        height = this.layer === 'transit' ? 3 + Math.min(stop.arrivals.length, 100) * 0.25 : 1.2
      mesh.visible = true
      mesh.position.set(stop.node.x + 6, height / 2 + 0.2, stop.node.z + 6)
      mesh.scale.y = height
      mesh.material.color.set(stop.arrivals.length > 40 ? '#f4a461' : '#46d6d4')
    })
    for (let i = engine.stops.length; i < this.stopMeshes.length; i++)
      this.stopMeshes[i].visible = false
    districtAreas.forEach((area, i) => {
      this.positionLabel(
        this.labels[i],
        area.x,
        35,
        area.z,
        this.layer === 'districts' || this.camera.position.distanceTo(this.controls.target) > 700,
      )
      this.labels[i].classList.toggle('selected', area.id === this.selected)
    })
    landmarks.forEach((site, i) =>
      this.positionLabel(
        this.landmarkLabels[i],
        site.x,
        site.height + 9,
        site.z,
        this.layer === 'city' && (this.focusedLandmark === '' || this.focusedLandmark === site.id),
      ),
    )
    this.renderer.render(this.scene, this.camera)
  }
  private positionLabel(
    label: HTMLButtonElement,
    x: number,
    y: number,
    z: number,
    visible: boolean,
  ) {
    this.projected.set(x, y, z).project(this.camera)
    const px = (this.projected.x * 0.5 + 0.5) * this.container.clientWidth,
      py = (-this.projected.y * 0.5 + 0.5) * this.container.clientHeight
    label.style.transform = `translate(${px}px,${py}px) translate(-50%,-50%)`
    label.style.display =
      visible &&
      this.projected.z < 1 &&
      px > 0 &&
      px < this.container.clientWidth &&
      py > 0 &&
      py < this.container.clientHeight
        ? ''
        : 'none'
  }
  private resize() {
    this.lastFrame = ''
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.camera.aspect = w / h
    this.camera.fov = w < h ? 65 : 43
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }
  private down = (event: PointerEvent) => {
    this.pointerStart = { x: event.clientX, y: event.clientY }
  }
  private up = (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5
    )
      return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.surface)[0],
      point = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point))
      return
    const index = (hit?.faceIndex ?? -1) * 3,
      road = this.ranges.find((r) => index >= r.start && index < r.start + r.count)
    if (
      point.x > cityBounds.minX &&
      point.x < cityBounds.maxX &&
      point.z > cityBounds.minZ &&
      point.z < cityBounds.maxZ
    )
      this.onSelect(districtAt(point.x, point.z), road?.id)
  }
  dispose() {
    this.disposed = true
    this.observer.disconnect()
    this.controls.dispose()
    this.renderer.domElement.removeEventListener('pointerdown', this.down)
    this.renderer.domElement.removeEventListener('pointerup', this.up)
    this.labels.concat(this.landmarkLabels).forEach((label) => label.remove())
    const materials = new Set<THREE.Material>(),
      geometries = new Set<THREE.BufferGeometry>()
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        geometries.add(obj.geometry)
        ;(Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) =>
          materials.add(m),
        )
      }
      if (obj instanceof THREE.InstancedMesh) obj.dispose()
    })
    geometries.forEach((g) => g.dispose())
    materials.forEach((m) => {
      if (m instanceof THREE.MeshStandardMaterial) m.map?.dispose()
      m.dispose()
    })
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
