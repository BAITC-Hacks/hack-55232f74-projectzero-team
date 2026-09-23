import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Config, Decision } from '../types'
import { districtAreas, districtAt, edges, elevation, pointOnEdge, roads, XS, ZS } from './network'
import type { DistrictId, Road } from './network'
import { randomSource } from './engine'
import type { TrafficEngine, TrafficSnapshot } from './engine'

export type CityLayer = 'city' | 'traffic' | 'transit' | 'districts'
const roadColor = (value: number) =>
  value > 0.65 ? '#f07354' : value > 0.35 ? '#edc35a' : '#63cba0'
const dummy = new THREE.Object3D()

function ribbon(road: Road, width: number, offset = 0, lift = 0): THREE.BufferGeometry {
  const vertices: number[] = [],
    indices: number[] = []
  const dx = (road.b.x - road.a.x) / road.length
  const dz = (road.b.z - road.a.z) / road.length
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    for (const side of [-1, 1]) {
      vertices.push(
        road.a.x + dx * road.length * t - dz * (offset + (side * width) / 2),
        elevation(road, t) + lift,
        road.a.z + dz * road.length * t + dx * (offset + (side * width) / 2),
      )
    }
    if (i < 10) {
      const j = i * 2
      indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export class CityRenderer {
  private scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private observer: ResizeObserver
  private ambient = new THREE.HemisphereLight(0xd9eef6, 0x829571, 2.4)
  private sunlight = new THREE.DirectionalLight(0xffe7c6, 3)
  private roadMeshes = new Map<
    string,
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  >()
  private laneMeshes: { mesh: THREE.Mesh; district: DistrictId }[] = []
  private transitLines: THREE.Mesh[] = []
  private signalLights!: THREE.InstancedMesh
  private stopMeshes: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = []
  private projectGroup = new THREE.Group()
  private cars: THREE.InstancedMesh
  private cabins: THREE.InstancedMesh
  private busMeshes: THREE.Mesh[] = []
  private labels: HTMLButtonElement[] = []
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
  private home = new THREE.Vector3(490, 570, 660)
  private projected = new THREE.Vector3()
  private textures: THREE.Texture[] = []
  private maxVehicles = 1000
  private lastFrame = ''
  private lastEngine: TrafficEngine | null = null

  constructor(
    private container: HTMLElement,
    private config: Config,
    private onSelect: (district: string, road?: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Buildings and trees are static; avoid rendering their shadow pass every frame.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    const gl = this.renderer.getContext()
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const gpu = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : ''
    if (/swiftshader|llvmpipe|software/i.test(gpu)) {
      this.renderer.setPixelRatio(1)
      this.renderer.shadowMap.enabled = false
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.setAttribute('aria-label', 'Интерактивный трёхмерный город')
    this.renderer.domElement.dataset.renderer = 'webgl'
    container.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color('#b9ced0')
    this.scene.fog = new THREE.Fog('#b9ced0', 950, 2200)
    this.camera = new THREE.PerspectiveCamera(43, 1, 1, 2600)
    this.camera.position.copy(this.home)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 15)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 160
    this.controls.maxDistance = 1450
    this.controls.minPolarAngle = 0.12
    this.controls.maxPolarAngle = Math.PI / 2.25
    this.controls.maxTargetRadius = 500
    this.controls.screenSpacePanning = false
    this.sunlight.position.set(-220, 500, -280)
    this.sunlight.castShadow = true
    this.sunlight.shadow.mapSize.set(1024, 1024)
    Object.assign(this.sunlight.shadow.camera, {
      left: -530,
      right: 530,
      top: 450,
      bottom: -450,
      near: 10,
      far: 1300,
    })
    this.sunlight.shadow.bias = -0.0003
    this.scene.add(this.ambient, this.sunlight)
    this.buildTerrain()
    this.buildRoads()
    this.buildingMaterial = this.makeFacade()
    this.buildCity()
    this.buildLandmark()
    this.scene.add(this.projectGroup)
    this.cars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.65, 1.05, 2.8),
      new THREE.MeshStandardMaterial({ roughness: 0.4 }),
      this.maxVehicles,
    )
    this.cabins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.4, 0.7, 1.5),
      new THREE.MeshStandardMaterial({ color: '#58717d', roughness: 0.3 }),
      this.maxVehicles,
    )
    this.cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cars.frustumCulled = this.cabins.frustumCulled = false
    this.scene.add(this.cars, this.cabins)
    districtAreas.forEach((area) => {
      const label = document.createElement('button')
      label.className = 'world-district-label'
      label.innerHTML = `<span class="world-label-dot" style="background:${area.color}"></span><strong>${area.name}</strong><small>РАЙОН</small>`
      label.setAttribute('aria-label', `Выбрать район ${area.name} в городе`)
      label.onclick = () => this.onSelect(area.id)
      container.appendChild(label)
      this.labels.push(label)
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(area.id === 'nura' || area.id === 'esil' ? 325 : 220, 195),
        new THREE.MeshBasicMaterial({
          color: area.color,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
        }),
      )
      plane.rotation.x = -Math.PI / 2
      plane.position.set(area.x, 0.05, area.z)
      this.scene.add(plane)
      this.districtPlanes.push(plane)
    })
    this.renderer.domElement.addEventListener('pointerdown', this.down)
    this.renderer.domElement.addEventListener('pointerup', this.up)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
  }

  private material(color: string) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
  }
  private box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
    group: THREE.Group | THREE.Scene = this.scene,
  ) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material(color))
    mesh.position.set(x, y + h / 2, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  private buildTerrain() {
    const random = randomSource(12)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#a9b996'
    ctx.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 10000; i++) {
      ctx.fillStyle = random() > 0.5 ? '#94a88722' : '#d5d6b522'
      ctx.fillRect(random() * 256, random() * 256, 2, 2)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(12, 12)
    this.textures.push(texture)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2200, 1600),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.5
    ground.receiveShadow = true
    this.scene.add(ground)
    for (const width of [55, 44]) {
      const shape = new THREE.Shape()
      for (let i = 0; i <= 80; i++) {
        const x = -1200 + i * 30,
          z = Math.sin(x * 0.006) * 13 - width / 2
        if (!i) shape.moveTo(x, -z)
        else shape.lineTo(x, -z)
      }
      for (let i = 80; i >= 0; i--) {
        const x = -1200 + i * 30,
          z = Math.sin(x * 0.006) * 13 + width / 2
        shape.lineTo(x, -z)
      }
      const river = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        this.material(width === 55 ? '#c8c9ae' : '#6fabb0'),
      )
      river.rotation.x = -Math.PI / 2
      river.position.y = width === 55 ? -0.2 : -0.1
      river.receiveShadow = true
      this.scene.add(river)
    }
  }

  private buildRoads() {
    const dashTransforms: { x: number; y: number; z: number; angle: number }[] = []
    for (const road of roads) {
      const sidewalk = new THREE.Mesh(
        ribbon(road, road.arterial ? 17 : 15),
        this.material('#c2c6bd'),
      )
      sidewalk.receiveShadow = true
      this.scene.add(sidewalk)
      const roadMesh = new THREE.Mesh(
        ribbon(road, road.arterial ? 13 : 11, 0, 0.05),
        this.material('#535b5f'),
      )
      roadMesh.receiveShadow = true
      roadMesh.userData.road = road.id
      this.scene.add(roadMesh)
      this.roadMeshes.set(road.id, roadMesh)
      const dx = (road.b.x - road.a.x) / road.length,
        dz = (road.b.z - road.a.z) / road.length
      for (let distance = 10; distance < road.length - 8; distance += 9) {
        dashTransforms.push({
          x: road.a.x + dx * distance,
          y: elevation(road, distance / road.length) + 0.09,
          z: road.a.z + dz * distance,
          angle: Math.atan2(dx, dz),
        })
      }
      for (const offset of [-4.1, 4.1]) {
        const lane = new THREE.Mesh(
          ribbon(road, 1.3, offset, 0.11),
          new THREE.MeshBasicMaterial({ color: '#36d1c4', transparent: true, opacity: 0.65 }),
        )
        lane.visible = false
        this.scene.add(lane)
        this.laneMeshes.push({
          mesh: lane,
          district: districtAt((road.a.x + road.b.x) / 2, (road.a.z + road.b.z) / 2),
        })
      }
      if (road.bridge) {
        for (const offset of [-7, 7]) {
          const rail = new THREE.Mesh(ribbon(road, 0.5, offset, 1.9), this.material('#e3e4d9'))
          this.scene.add(rail)
        }
        for (const t of [0.3, 0.7])
          this.box(road.a.x, -0.5, road.a.z + (road.b.z - road.a.z) * t, 10, 3.4, 3, '#bbbeb5')
      }
    }
    const markings = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.3, 4),
      new THREE.MeshBasicMaterial({ color: '#ece5c1' }),
      dashTransforms.length,
    )
    dashTransforms.forEach((point, i) => {
      dummy.position.set(point.x, point.y, point.z)
      dummy.rotation.set(-Math.PI / 2, 0, -point.angle)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      markings.setMatrixAt(i, dummy.matrix)
    })
    this.scene.add(markings)
    const poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.25, 3.5, 5),
      this.material('#495750'),
      edges.length,
    )
    const housings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.8, 1.4, 0.6),
      this.material('#243c32'),
      edges.length,
    )
    this.signalLights = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.42, 6, 4),
      new THREE.MeshBasicMaterial(),
      edges.length,
    )
    const crosswalks = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 2.6),
      new THREE.MeshBasicMaterial({ color: '#d9ded4' }),
      edges.length * 4,
    )
    edges.forEach((edge, i) => {
      const p = pointOnEdge(edge, edge.length - 5, true)
      dummy.rotation.set(0, p.angle, 0)
      dummy.scale.set(1, 1, 1)
      dummy.position.set(p.x, p.y + 1.75, p.z)
      dummy.updateMatrix()
      poles.setMatrixAt(i, dummy.matrix)
      dummy.position.y = p.y + 3.5
      dummy.updateMatrix()
      housings.setMatrixAt(i, dummy.matrix)
      dummy.position.y = p.y + 4.35
      dummy.updateMatrix()
      this.signalLights.setMatrixAt(i, dummy.matrix)
      const dx = (edge.to.x - edge.from.x) / edge.length,
        dz = (edge.to.z - edge.from.z) / edge.length
      for (let stripe = 0; stripe < 4; stripe++) {
        dummy.rotation.set(-Math.PI / 2, 0, -p.angle)
        dummy.position.set(
          edge.to.x - dx * 7 - dz * (stripe * 1.25 + 0.8),
          p.y + 0.08,
          edge.to.z - dz * 7 + dx * (stripe * 1.25 + 0.8),
        )
        dummy.updateMatrix()
        crosswalks.setMatrixAt(i * 4 + stripe, dummy.matrix)
      }
    })
    this.scene.add(poles, housings, this.signalLights, crosswalks)
    // Footpaths along the river give the waterfront a readable edge.
    for (const z of [-43, 43]) this.box(0, -0.1, z, 735, 0.15, 3, '#d7d5bd')
  }

  private makeFacade() {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 256
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#dadcd6'
    ctx.fillRect(0, 0, 128, 256)
    for (let y = 9; y < 248; y += 22)
      for (let x = 7; x < 124; x += 20) {
        ctx.fillStyle = '#74909c'
        ctx.fillRect(x, y, 10, 13)
        ctx.fillStyle = '#bacbd0'
        ctx.fillRect(x, y + 1, 9, 2)
      }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.textures.push(texture)
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 })
  }

  private buildCity() {
    const random = randomSource(193)
    const buildings: { x: number; z: number; w: number; d: number; h: number; color: string }[] = []
    const trees: { x: number; z: number; size: number }[] = []
    const palette = ['#e4e0d3', '#f0ece2', '#bfd0d3', '#d1d2c6', '#c7c8c3', '#dccabb']
    for (let r = 0; r < ZS.length - 1; r++)
      for (let c = 0; c < XS.length - 1; c++) {
        if (r === 2) continue
        const park = (r === 3 && c === 3) || (r === 0 && c === 2) || (r === 4 && c === 0)
        const blockX = (XS[c] + XS[c + 1]) / 2,
          blockZ = (ZS[r] + ZS[r + 1]) / 2
        this.box(blockX, -0.1, blockZ, 92, 0.08, 82, park ? '#8cae7e' : '#abb79c')
        for (let bx = 0; bx < 4; bx++)
          for (let bz = 0; bz < 3; bz++) {
            const x = XS[c] + 22 + bx * 22,
              z = ZS[r] + 21 + bz * 28
            const district = districtAt(x, z)
            if (park || random() < 0.1) {
              if (!(r === 3 && c === 3))
                for (let t = 0; t < 3; t++)
                  trees.push({
                    x: x - 7 + random() * 14,
                    z: z - 7 + random() * 14,
                    size: 3 + random() * 2,
                  })
              continue
            }
            const office = district === 'esil' && c >= 3 && random() > 0.55
            const h = office
              ? 30 + random() * 45
              : district === 'nura'
                ? 6 + random() * 13
                : 9 + random() * 25
            buildings.push({
              x,
              z,
              w: 12 + random() * 6,
              d: 13 + random() * 7,
              h,
              color: office ? '#b9d1da' : palette[Math.floor(random() * palette.length)],
            })
          }
      }
    for (const road of roads) {
      if (road.bridge) continue
      const dx = (road.b.x - road.a.x) / road.length,
        dz = (road.b.z - road.a.z) / road.length
      for (let distance = 15; distance < road.length - 8; distance += 18)
        for (const side of [-1, 1]) {
          trees.push({
            x: road.a.x + dx * distance - dz * 11 * side,
            z: road.a.z + dz * distance + dx * 11 * side,
            size: 2 + random() * 1.5,
          })
        }
    }
    const bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      this.buildingMaterial,
      buildings.length,
    )
    const roofs = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      this.material('#d7d7cc'),
      buildings.length,
    )
    const equipment = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      this.material('#b3bab7'),
      buildings.length,
    )
    buildings.forEach((b, i) => {
      dummy.rotation.set(0, 0, 0)
      dummy.position.set(b.x, b.h / 2, b.z)
      dummy.scale.set(b.w, b.h, b.d)
      dummy.updateMatrix()
      bodies.setMatrixAt(i, dummy.matrix)
      bodies.setColorAt(i, new THREE.Color(b.color))
      dummy.position.y = b.h + 0.4
      dummy.scale.set(b.w + 0.4, 0.8, b.d + 0.4)
      dummy.updateMatrix()
      roofs.setMatrixAt(i, dummy.matrix)
      dummy.position.set(b.x + 2, b.h + 1.3, b.z)
      dummy.scale.set(3, 1.5, 4)
      dummy.updateMatrix()
      equipment.setMatrixAt(i, dummy.matrix)
    })
    bodies.castShadow = bodies.receiveShadow = roofs.receiveShadow = true
    this.scene.add(bodies, roofs, equipment)
    const foliage = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      this.material('#60906a'),
      trees.length,
    )
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.35, 0.5, 3, 5),
      this.material('#756d55'),
      trees.length,
    )
    trees.forEach((tree, i) => {
      dummy.rotation.set(0, random() * Math.PI, 0)
      dummy.position.set(tree.x, tree.size + 1.6, tree.z)
      dummy.scale.set(tree.size, tree.size * 1.3, tree.size)
      dummy.updateMatrix()
      foliage.setMatrixAt(i, dummy.matrix)
      foliage.setColorAt(
        i,
        new THREE.Color().setHSL(0.24 + random() * 0.07, 0.22, 0.5 + random() * 0.2),
      )
      dummy.position.y = 1.5
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      trunks.setMatrixAt(i, dummy.matrix)
    })
    foliage.castShadow = true
    this.scene.add(foliage, trunks)
  }

  private buildLandmark() {
    const group = new THREE.Group()
    group.position.set(52, 0, 112)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(15, 18, 3, 32), this.material('#e4ded0'))
    base.position.y = 1.5
    group.add(base)
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 1.1, 48, 6),
        this.material('#e6e4d8'),
      )
      column.position.set(Math.cos(a) * 5.5, 25, Math.sin(a) * 5.5)
      column.rotation.z = Math.cos(a) * -0.09
      column.rotation.x = Math.sin(a) * 0.09
      column.castShadow = true
      group.add(column)
    }
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 16),
      new THREE.MeshStandardMaterial({ color: '#d8b35b', metalness: 0.55, roughness: 0.22 }),
    )
    orb.position.y = 48
    orb.castShadow = true
    group.add(orb)
    for (const z of [-32, 32]) this.box(0, 0, z, 50, 0.15, 5, '#d9d6c3', group)
    this.scene.add(group)
  }

  setOptions(layer: CityLayer, selected: string, night: boolean, selectedRoad: string | null) {
    this.layer = layer
    this.selected = selected
    this.selectedRoad = selectedRoad
    if (night !== this.night) {
      this.night = night
      this.scene.background = new THREE.Color(night ? '#34485b' : '#b9ced0')
      this.scene.fog = new THREE.Fog(night ? '#34485b' : '#b9ced0', 950, 2200)
      this.ambient.intensity = night ? 0.8 : 2.4
      this.sunlight.intensity = night ? 0.7 : 3
      this.buildingMaterial.emissive.set(night ? '#554426' : '#000000')
      this.buildingMaterial.emissiveIntensity = night ? 0.35 : 0
    }
  }

  focusDistrict(id: string) {
    const area = districtAreas.find((d) => d.id === id)
    if (!area) return
    const offset = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize()
      .multiplyScalar(480)
    this.controls.target.set(area.x, 0, area.z)
    this.camera.position.copy(this.controls.target).add(offset)
  }
  resetCamera() {
    this.camera.position.copy(this.home)
    this.controls.target.set(0, 0, 15)
  }
  zoom(inward: boolean) {
    const offset = this.camera.position
      .clone()
      .sub(this.controls.target)
      .multiplyScalar(inward ? 0.8 : 1.25)
    offset.clampLength(160, 1450)
    this.camera.position.copy(this.controls.target).add(offset)
  }

  private updateProjects(decisions: Decision[], engine: TrafficEngine) {
    const key = JSON.stringify(decisions)
    if (key === this.projectKey) return
    this.projectKey = key
    for (const mesh of this.transitLines) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.transitLines = []
    this.projectGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.Material).dispose()
      }
    })
    this.projectGroup.clear()
    decisions.forEach((decision, i) => {
      const measure = this.config.measures.find((m) => m.id === decision.measure_id)!
      const area = districtAreas.find((d) => d.id === decision.district_id) || districtAreas[1]
      const color = this.config.categories.find((c) => c.id === measure.category)!.color
      const x = area.x + (i % 2 ? 14 : -14),
        z = area.z + 30
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(9, 10.5, 32),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(x, 0.5, z)
      this.projectGroup.add(ring)
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 24, 6),
        new THREE.MeshBasicMaterial({ color }),
      )
      beacon.position.set(x, 12, z)
      this.projectGroup.add(beacon)
      const dot = new THREE.Mesh(
        new THREE.OctahedronGeometry(2.2),
        new THREE.MeshBasicMaterial({ color }),
      )
      dot.position.set(x, 25, z)
      this.projectGroup.add(dot)
    })
    for (const lane of this.laneMeshes) lane.mesh.visible = engine.settings[lane.district].busLane
    const railRoads = new Set(
      engine.vehicles.filter((v) => v.kind === 'tram').flatMap((v) => v.path.map((e) => e.road)),
    )
    for (const road of railRoads)
      for (const offset of [-4.65, -3.75, 3.75, 4.65]) {
        const rail = new THREE.Mesh(ribbon(road, 0.22, offset, 0.14), this.material('#d0cbd7'))
        this.projectGroup.add(rail)
      }
  }

  draw(engine: TrafficEngine, snapshot: TrafficSnapshot, decisions: Decision[]) {
    if (this.disposed) return
    const cameraChanged = this.controls.update()
    const frame = `${engine.elapsed}:${this.layer}:${this.selected}:${this.night}:${this.selectedRoad}:${JSON.stringify(decisions)}`
    if (!cameraChanged && frame === this.lastFrame && engine === this.lastEngine) return
    this.lastFrame = frame
    this.lastEngine = engine
    edges.forEach((edge, i) =>
      this.signalLights.setColorAt(
        i,
        new THREE.Color(engine.isGreen(edge) ? '#8cdfab' : '#e4775c'),
      ),
    )
    if (this.signalLights.instanceColor) this.signalLights.instanceColor.needsUpdate = true
    this.updateProjects(decisions, engine)
    for (const reading of snapshot.roads) {
      const mesh = this.roadMeshes.get(reading.id)!
      mesh.material.color.set(
        this.layer === 'traffic'
          ? roadColor(reading.congestion)
          : reading.id === this.selectedRoad
            ? '#769eb1'
            : '#535b5f',
      )
    }
    this.districtPlanes.forEach((plane) => {
      plane.visible = this.layer === 'districts'
    })
    if (this.transitLines.length === 0) {
      const routeEdges = new Set(
        engine.vehicles.filter((v) => v.kind !== 'car').flatMap((v) => v.path.map((e) => e.id)),
      )
      for (const edge of edges.filter((e) => routeEdges.has(e.id))) {
        const mesh = new THREE.Mesh(
          ribbon(edge.road, 0.7, -5, 0.15),
          new THREE.MeshBasicMaterial({ color: '#32d9db' }),
        )
        this.scene.add(mesh)
        this.transitLines.push(mesh)
      }
    }
    this.transitLines.forEach((mesh) => {
      mesh.visible = this.layer === 'transit'
    })
    let carIndex = 0,
      busIndex = 0
    for (const vehicle of engine.vehicles) {
      const point = pointOnEdge(
        vehicle.path[vehicle.segment],
        vehicle.position,
        engine.isPriority(vehicle),
      )
      if (vehicle.kind === 'car' && carIndex < this.maxVehicles) {
        dummy.position.set(point.x, point.y + 0.75, point.z)
        dummy.rotation.set(0, point.angle, 0)
        dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        this.cars.setMatrixAt(carIndex, dummy.matrix)
        this.cars.setColorAt(carIndex, new THREE.Color(vehicle.color))
        dummy.position.y += 0.65
        dummy.updateMatrix()
        this.cabins.setMatrixAt(carIndex, dummy.matrix)
        carIndex++
      } else if (vehicle.kind !== 'car') {
        if (!this.busMeshes[busIndex]) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(2.3, 2, 1),
            new THREE.MeshStandardMaterial({ roughness: 0.4 }),
          )
          const windows = new THREE.Mesh(
            new THREE.BoxGeometry(2.35, 0.7, 0.82),
            new THREE.MeshStandardMaterial({ color: '#344959', roughness: 0.25 }),
          )
          windows.position.y = 0.3
          mesh.add(windows)
          this.busMeshes.push(mesh)
          this.scene.add(mesh)
        }
        const mesh = this.busMeshes[busIndex++]
        mesh.visible = true
        mesh.position.set(point.x, point.y + 1.25, point.z)
        mesh.rotation.y = point.angle
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
          new THREE.CylinderGeometry(2.8, 2.8, 1, 12),
          new THREE.MeshBasicMaterial({ color: '#50d4cc', transparent: true, opacity: 0.9 }),
        )
        this.stopMeshes.push(mesh)
        this.scene.add(mesh)
      }
      const mesh = this.stopMeshes[i]
      const height = this.layer === 'transit' ? 3 + Math.min(stop.arrivals.length, 100) * 0.25 : 1.2
      mesh.visible = true
      mesh.position.set(stop.node.x + 9, height / 2 + 0.2, stop.node.z + 9)
      mesh.scale.y = height
      mesh.material.color.set(stop.arrivals.length > 40 ? '#f4a461' : '#46d6d4')
    })
    for (let i = engine.stops.length; i < this.stopMeshes.length; i++)
      this.stopMeshes[i].visible = false
    districtAreas.forEach((area, i) => {
      this.projected.set(area.x, 50, area.z).project(this.camera)
      const x = (this.projected.x * 0.5 + 0.5) * this.container.clientWidth
      const y = (-this.projected.y * 0.5 + 0.5) * this.container.clientHeight
      this.labels[i].style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
      this.labels[i].style.display =
        this.projected.z < 1 &&
        x > 0 &&
        x < this.container.clientWidth &&
        y > 0 &&
        y < this.container.clientHeight
          ? ''
          : 'none'
      this.labels[i].classList.toggle('selected', area.id === this.selected)
    })
    this.renderer.render(this.scene, this.camera)
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
    const roadHit = this.raycaster.intersectObjects([...this.roadMeshes.values()])[0]
    const point = new THREE.Vector3()
    this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point)
    if (Math.abs(point.x) < 420 && Math.abs(point.z) < 330)
      this.onSelect(districtAt(point.x, point.z), roadHit?.object.userData.road)
  }

  dispose() {
    this.disposed = true
    this.observer.disconnect()
    this.controls.dispose()
    this.renderer.domElement.removeEventListener('pointerdown', this.down)
    this.renderer.domElement.removeEventListener('pointerup', this.up)
    this.labels.forEach((label) => label.remove())
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach((material) => material.dispose())
      }
    })
    this.textures.forEach((texture) => texture.dispose())
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
