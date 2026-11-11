import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import { TOUR_URL, type SceneData } from '../types'

// Ordem do CubeTexture: px,nx,py,ny,pz,nz. O three espelha o X de cubemaps (convenção left-handed),
// então as 6 faces do Marzipano só se emendam com a frente em +z: r,l,u,d,f,b.
// backgroundRotation gira π p/ a frente cair em −z, que é a convenção de yaw/pitch do Marzipano
// (frente = −z, direita = +x, pitch positivo = para BAIXO).
const FACES = 'rludfb'
const RADIUS = 6
const MAX_FACE = 2048 // 6 faces de 2048² ≈ 134 MB de GPU (com mipmaps); 4096 estoura memória no Quest
const loader = new THREE.ImageLoader()

/** Costura os tiles do nível z (índice em levels[] = pasta {z} do Marzipano) num cubo. */
async function loadCube(s: SceneData, z: number) {
  const { size, tileSize } = s.levels[z]
  const n = Math.ceil(size / tileSize)
  const faces = await Promise.all([...FACES].map(async (f) => {
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size })
    const ctx = c.getContext('2d')!
    await Promise.all(Array.from({ length: n * n }, async (_, i) => {
      const x = i % n, y = Math.floor(i / n)
      ctx.drawImage(await loader.loadAsync(`${TOUR_URL}/tiles/${s.id}/${z}/${f}/${y}/${x}.jpg`), x * tileSize, y * tileSize)
    }))
    return c
  }))
  const tex = new THREE.CubeTexture(faces)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/**
 * Sessão VR com three.js: cubo costurado dos tiles + hotspots de link clicáveis por controle.
 * A cabeça (giroscópio do headset) vem do WebXR. Nada é baixado nem desenhado fora da sessão.
 */
export function initXR(onNavigate: (id: string) => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local')
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100)
  const hotspots = new THREE.Group()
  scene.add(hotspots)

  const linkMat = new THREE.MeshBasicMaterial({
    map: new THREE.TextureLoader().load(`${TOUR_URL}/img/link.png`, (t) => (t.colorSpace = THREE.SRGBColorSpace)),
    transparent: true,
  })
  const linkGeo = new THREE.PlaneGeometry(0.8, 0.8)
  let current: SceneData | undefined
  let seq = 0 // invalida cargas de uma cena/sessão que já passou
  let face: number | null = null // yaw da cena a pôr à frente do olhar no próximo frame

  const setBackground = (tex: THREE.CubeTexture | null) => {
    ;(scene.background as THREE.Texture | null)?.dispose() // 1 cubo por vez: o Quest 2 não aguenta vários
    scene.background = tex
  }

  /** Mostra a cena (só dentro da sessão): nível mais baixo primeiro, que chega rápido, depois o mais nítido. */
  const enter = async (s: SceneData) => {
    const id = ++seq
    hotspots.clear() // somem no clique; os da cena nova entram junto com a imagem dela
    const zs = s.levels.flatMap((l, z) => (l.fallbackOnly || l.size > MAX_FACE ? [] : [z]))
    const loads = [...new Set([zs[0], zs.at(-1)!])].map((z) =>
      loadCube(s, z).catch((err) => (console.error('[XR] tiles', s.id, z, err), null)))
    let first = true
    for (const load of loads) {
      const tex = await load
      if (id !== seq) { tex?.dispose(); continue } // trocou de cena ou saiu do VR durante a carga
      if (tex) setBackground(tex)
      if (!first) continue
      first = false
      for (const h of s.linkHotspots) {
        const mesh = new THREE.Mesh(linkGeo, linkMat)
        mesh.position.set(
          RADIUS * Math.sin(h.yaw) * Math.cos(h.pitch),
          -RADIUS * Math.sin(h.pitch),
          -RADIUS * Math.cos(h.yaw) * Math.cos(h.pitch),
        )
        mesh.lookAt(0, 0, 0)
        mesh.userData.target = h.target
        hotspots.add(mesh)
      }
      // ponytail: toda cena abre com a vista inicial à frente do olhar (igual ao 2D). Para manter o
      // rumo de viagem entre cenas, alinhar pelo hotspot de volta da cena nova em vez deste yaw.
      face = s.initialViewParameters.yaw
    }
  }

  const ray = new THREE.Raycaster()
  const m = new THREE.Matrix4()
  for (const i of [0, 1]) {
    const ctrl = renderer.xr.getController(i)
    ctrl.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -RADIUS)])))
    ctrl.addEventListener('select', () => {
      m.identity().extractRotation(ctrl.matrixWorld)
      ray.ray.origin.setFromMatrixPosition(ctrl.matrixWorld)
      ray.ray.direction.set(0, 0, -1).applyMatrix4(m)
      const hit = ray.intersectObjects(hotspots.children)[0]
      if (hit) onNavigate(hit.object.userData.target)
    })
    scene.add(ctrl)
  }

  document.body.append(VRButton.createButton(renderer))
  renderer.xr.addEventListener('sessionstart', () => { if (current) void enter(current) })
  renderer.xr.addEventListener('sessionend', () => {
    seq++
    hotspots.clear()
    setBackground(null)
  })

  renderer.setAnimationLoop((_time, frame?: XRFrame) => {
    if (!frame) return // fora da sessão VR não há o que desenhar (o canvas nem está no DOM)
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace()!)
    if (pose) {
      // Foto 360 não tem profundidade: os hotspots acompanham a posição da cabeça, como o fundo.
      // Só a rotação conta, então andar/inclinar não descola o hotspot da imagem.
      hotspots.position.copy(pose.transform.position)
      if (face !== null) {
        const head = pose.transform.matrix // coluna 2 = eixo z da cabeça; o olhar é −z
        const turn = face - Math.atan2(-head[8], head[10])
        hotspots.rotation.y = turn
        scene.backgroundRotation.y = Math.PI + turn
        face = null
      }
    }
    renderer.render(scene, camera)
  })

  return {
    setScene(s: SceneData) {
      current = s
      if (renderer.xr.isPresenting) void enter(s)
    },
  }
}
