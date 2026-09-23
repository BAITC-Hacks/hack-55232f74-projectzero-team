import * as THREE from 'three'
import type { Landmark } from './geography'

// Original, stylized geometry; no assets from commercial games. Silhouettes are exaggerated
// for the city-scale camera; these are not surveyed architectural models.
export function buildLandmark(site: Landmark) {
  const group = new THREE.Group()
  group.position.set(site.x, 0, site.z)
  const white = new THREE.MeshStandardMaterial({ color: '#e8e5d7', roughness: 0.75 })
  const stone = new THREE.MeshStandardMaterial({ color: '#d8c6ac', roughness: 0.8 })
  const glass = new THREE.MeshStandardMaterial({
    color: '#57959f',
    metalness: 0.45,
    roughness: 0.24,
  })
  const gold = new THREE.MeshStandardMaterial({
    color: '#c9a54b',
    metalness: 0.65,
    roughness: 0.25,
  })
  const blue = new THREE.MeshStandardMaterial({ color: '#20829f', metalness: 0.35, roughness: 0.3 })
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, mat = white) =>
    add(new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z)
  const cylinder = (x: number, y: number, z: number, r: number, h: number, mat = white, top = r) =>
    add(new THREE.CylinderGeometry(top, r, h, 24), mat, x, y + h / 2, z)
  const sphere = (x: number, y: number, z: number, r: number, mat = glass) =>
    add(new THREE.SphereGeometry(r, 24, 16), mat, x, y, z)
  const beam = (points: THREE.Vector3[], radius = 0.2, mat = white) =>
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, radius, 5, false), mat)
  const plaza = add(
    new THREE.CylinderGeometry(site.radius, site.radius, 0.3, 48),
    stone,
    0,
    0.03,
    0,
  )
  plaza.castShadow = false
  if (site.id === 'bayterek') {
    cylinder(0, 0.2, 0, 5.5, 1.1)
    for (let i = 0; i < 14; i++) {
      const a = (i * Math.PI) / 7,
        polar = (r: number, y: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
      beam([polar(3.7, 1), polar(1.2, 12), polar(2.8, 23), polar(5.8, 31)], 0.25)
    }
    cylinder(0, 25.8, 0, 3.8, 0.8)
    sphere(0, 31.5, 0, 5.3, gold)
    cylinder(0, 1, 0, 1, 25, glass)
    const ring = add(new THREE.TorusGeometry(4.7, 0.35, 8, 32), white, 0, 29, 0)
    ring.rotation.x = Math.PI / 2
  } else if (site.id === 'khan-shatyr') {
    cylinder(0, 0.2, 0, 26, 2.5, stone)
    const vertices: number[] = [],
      indices: number[] = []
    for (let row = 0; row <= 12; row++)
      for (let i = 0; i <= 64; i++) {
        const t = row / 12,
          a = (i * Math.PI) / 32,
          r = 26 * Math.pow(1 - t, 0.72)
        vertices.push(Math.cos(a) * r + 6 * t * t, 3 + 44 * t, Math.sin(a) * r * 0.78 - 4 * t * t)
        if (row < 12 && i < 64) {
          const k = row * 65 + i
          indices.push(k, k + 65, k + 1, k + 1, k + 65, k + 66)
        }
      }
    const roof = new THREE.BufferGeometry()
    roof.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    roof.setIndex(indices)
    roof.computeVertexNormals()
    const membrane = new THREE.MeshStandardMaterial({
      color: '#c5d8d4',
      metalness: 0.2,
      roughness: 0.4,
      side: THREE.DoubleSide,
    })
    add(roof, membrane)
    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI) / 12,
        points = []
      for (let j = 0; j <= 12; j++) {
        const t = j / 12,
          r = 26 * Math.pow(1 - t, 0.72)
        points.push(
          new THREE.Vector3(
            Math.cos(a) * r + 6 * t * t,
            3.2 + 44 * t,
            Math.sin(a) * r * 0.78 - 4 * t * t,
          ),
        )
      }
      beam(points, 0.14)
    }
    cylinder(6, 44, -4, 0.28, 11, white)
  } else if (site.id === 'akorda') {
    box(0, 0.2, 0, 30, 7, 18)
    box(0, 7, 0, 17, 5, 14)
    box(-19, 0.2, 0, 8, 5, 14)
    box(19, 0.2, 0, 8, 5, 14)
    cylinder(0, 12, 0, 5.8, 2)
    add(new THREE.SphereGeometry(5.8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), blue, 0, 14, 0)
    cylinder(0, 19.8, 0, 0.25, 7, gold, 0.1)
    sphere(0, 27, 0, 0.8, gold)
    for (let i = -6; i <= 6; i++) {
      cylinder(i * 2, 1, 10, 0.4, 6)
      box(i * 2, 6.8, 10, 1, 0.5, 1)
    }
    for (const x of [-22, 22]) {
      cylinder(x, 5, 0, 1.7, 1)
      sphere(x, 7, 0, 1.7, gold)
    }
    box(0, 0.1, 12, 21, 0.5, 6, stone)
  } else if (site.id === 'palace') {
    box(0, 0.2, 0, 32, 1.5, 32, stone)
    const pyramid = add(new THREE.ConeGeometry(21, 29, 4, 4), glass, 0, 16, 0)
    pyramid.rotation.y = Math.PI / 4
    const lines = new THREE.LineSegments(
      new THREE.WireframeGeometry(pyramid.geometry),
      new THREE.LineBasicMaterial({ color: '#b0ced1', transparent: true, opacity: 0.6 }),
    )
    lines.position.copy(pyramid.position)
    lines.rotation.copy(pyramid.rotation)
    group.add(lines)
    const cap = add(new THREE.ConeGeometry(5.2, 7, 4), white, 0, 27, 0)
    cap.rotation.y = Math.PI / 4
  } else if (site.id === 'expo') {
    cylinder(0, 0.2, 0, 21, 2, stone)
    sphere(0, 17, 0, 15, glass)
    for (let i = 0; i < 12; i++) {
      const meridian = add(new THREE.TorusGeometry(15.15, 0.12, 5, 48), white, 0, 17, 0)
      meridian.rotation.y = (i * Math.PI) / 12
    }
    const equator = add(new THREE.TorusGeometry(15.15, 0.18, 5, 48), white, 0, 17, 0)
    equator.rotation.x = Math.PI / 2
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        x = Math.cos(a) * 34,
        z = Math.sin(a) * 34
      const pavilion = box(x, 0.3, z, 14, 6, 12, white)
      pavilion.rotation.y = -a
      const roof = box(x, 6.4, z, 14.6, 0.5, 12.6, glass)
      roof.rotation.y = -a
    }
  } else if (site.id === 'opera') {
    box(0, 0.2, 0, 39, 9, 25, stone)
    box(0, 9, -3, 24, 6, 19, white)
    box(0, 1, 16, 39, 0.8, 7, white)
    for (let i = -5; i <= 5; i++) cylinder(i * 3.1, 1.8, 14, 0.65, 8.5)
    box(0, 10.3, 14, 37, 1.2, 5)
    const triangle = new THREE.Shape().moveTo(-18, 0).lineTo(18, 0).lineTo(0, 4.5).closePath()
    add(new THREE.ExtrudeGeometry(triangle, { depth: 4, bevelEnabled: false }), stone, 0, 11.5, 12)
    // Bronze quadriga silhouette above the portico.
    for (const x of [-2, -0.7, 0.7, 2]) {
      box(x, 17, 13, 0.8, 1.2, 2, gold)
      cylinder(x, 18.2, 12.3, 0.3, 1.5, gold)
    }
  } else if (site.id === 'mosque') {
    box(0, 0.2, 0, 34, 7, 27)
    cylinder(0, 7, 0, 7.5, 2)
    add(new THREE.SphereGeometry(7.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white, 0, 9, 0)
    cylinder(0, 16.5, 0, 0.22, 4, gold, 0.08)
    for (const x of [-11, 11]) for (const z of [-8, 8]) sphere(x, 8, z, 3.7, white)
    for (const x of [-22, 22])
      for (const z of [-18, 18]) {
        cylinder(x, 0, z, 1.2, 25)
        cylinder(x, 22, z, 2, 0.7)
        cylinder(x, 26, z, 1.8, 4, white, 0.1)
        cylinder(x, 30, z, 0.15, 3, gold)
      }
    box(0, 0.3, 20, 20, 0.5, 10, stone)
  }
  return group
}
