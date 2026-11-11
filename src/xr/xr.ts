import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import { TOUR_URL, type InfoHotspot, type SceneData } from '../types'

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

/** Textura a partir de um canvas 2D (o DOM não aparece dentro da sessão imersiva). */
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
  draw(c.getContext('2d')!)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const PANEL_W = 1024, PAD = 36, LINE = 44, HEAD = 84
const TEXT_FONT = '32px system-ui, sans-serif'

/** Painel de info (título + texto com quebra de linha), nas cores do .hotspot-info do 2D. */
function infoPanel({ title, text }: InfoHotspot) {
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = TEXT_FONT
  const lines: string[] = []
  let line = ''
  for (const word of (text ?? '').split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure.measureText(next).width > PANEL_W - 2 * PAD) { lines.push(line); line = word } else line = next
  }
  if (line) lines.push(line)
  const head = title ? HEAD : 0
  const height = head + 2 * PAD + lines.length * LINE
  const tex = canvasTexture(PANEL_W, height, (ctx) => {
    ctx.fillStyle = 'rgba(15, 23, 42, .9)'
    ctx.fillRect(0, 0, PANEL_W, height)
    ctx.textBaseline = 'middle'
    if (title) {
      ctx.fillStyle = '#1E293B'
      ctx.fillRect(0, 0, PANEL_W, HEAD)
      ctx.fillStyle = '#FFF'
      ctx.font = 'bold 36px system-ui, sans-serif'
      ctx.fillText(title, PAD, HEAD / 2, PANEL_W - 2 * PAD) // maxWidth espreme título comprido
    }
    ctx.fillStyle = '#F8FAFC'
    ctx.font = TEXT_FONT
    lines.forEach((l, i) => ctx.fillText(l, PAD, head + PAD + LINE * (i + 0.5)))
  })
  const width = 3.2 // metros a ~4,5 m: ~1° por linha de texto, legível no Quest
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, (width * height) / PANEL_W),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  )
}

/**
 * Sessão VR com three.js: cubo costurado dos tiles + hotspots de link e de info clicáveis por controle.
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
  const infoMat = new THREE.MeshBasicMaterial({
    map: canvasTexture(128, 128, (ctx) => {
      ctx.fillStyle = '#1E293B'
      ctx.beginPath()
      ctx.arc(64, 64, 60, 0, 2 * Math.PI)
      ctx.fill()
      ctx.fillStyle = '#FFF'
      ctx.font = 'bold 80px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('i', 64, 68)
    }),
    transparent: true,
  })
  const infoGeo = new THREE.PlaneGeometry(0.5, 0.5)
  let panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null // 1 painel aberto por vez

  /** Põe o mesh na direção yaw/pitch do Marzipano, a r metros, virado para o centro. */
  const place = (mesh: THREE.Mesh, h: { yaw: number; pitch: number }, r: number) => {
    mesh.position.set(r * Math.sin(h.yaw) * Math.cos(h.pitch), -r * Math.sin(h.pitch), -r * Math.cos(h.yaw) * Math.cos(h.pitch))
    mesh.lookAt(0, 0, 0)
    hotspots.add(mesh)
  }

  const closePanel = () => {
    if (!panel) return
    hotspots.remove(panel)
    panel.material.map?.dispose()
    panel.material.dispose()
    panel.geometry.dispose()
    panel = null
  }
  const clearHotspots = () => { closePanel(); hotspots.clear() }
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
    clearHotspots() // somem no clique; os da cena nova entram junto com a imagem dela
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
        mesh.userData.target = h.target
        place(mesh, h, RADIUS)
      }
      for (const h of s.infoHotspots) {
        const mesh = new THREE.Mesh(infoGeo, infoMat)
        mesh.userData.info = h
        place(mesh, h, RADIUS)
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
      const hit = ray.intersectObjects(hotspots.children)[0]?.object
      const info: InfoHotspot | undefined = hit?.userData.info
      const reopen = info && panel?.userData.info !== info
      closePanel() // clicar no painel, no mesmo "i" ou fora fecha
      if (hit?.userData.target) onNavigate(hit.userData.target)
      else if (info && reopen) {
        panel = infoPanel(info)
        panel.userData.info = info
        place(panel, info, RADIUS - 1.5) // à frente do "i", cobre o marcador
      }
    })
    scene.add(ctrl)
  }

  document.body.append(VRButton.createButton(renderer))
  renderer.xr.addEventListener('sessionstart', () => { if (current) void enter(current) })
  renderer.xr.addEventListener('sessionend', () => {
    seq++
    clearHotspots()
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
