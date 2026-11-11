import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import { TOUR_URL, type InfoHotspot, type SceneData } from '../types'

// Convenção de yaw/pitch do Marzipano: frente = −z, direita = +x, pitch positivo = para BAIXO.
// O fundo é um cubo de planos, 1 por tile, em vez de 1 CubeTexture costurado em canvas: medido no
// Quest 2, costurar e subir 6 faces de 2048² de uma vez congelava ~0,6 s e deixava ~1 s a 10 fps a
// cada troca de cena. Tile de 512² sobe em ~1 ms, então dá para subir poucos por frame.
// Rotação [x, y] que leva a face da frente (em −z) a cada face do cubo, como no CubeGeometry do Marzipano.
const FACE_ROT: Record<string, [number, number]> = {
  f: [0, 0], b: [0, Math.PI], l: [0, Math.PI / 2], r: [0, -Math.PI / 2], u: [Math.PI / 2, 0], d: [-Math.PI / 2, 0],
}
const SKY = 10 // meia-aresta do cubo de fundo, em metros (atrás dos hotspots)
const UPLOADS_PER_FRAME = 4
// Andar com o corpo: um passo real na direção de um hotspot de link troca de cena.
const WALK_STEP = 0.6 // metros de deslocamento da cabeça; inclinar o tronco dá ~0,3 m e não dispara
const WALK_CONE = (40 * Math.PI) / 180 // tolerância entre a direção do passo e a do hotspot
const UP = new THREE.Vector3(0, 1, 0)
const RADIUS = 6
const FADE_MS = 400 // duração de cada metade (escurecer / clarear) da troca de cena
const MAX_FACE = 2048 // 96 tiles de 512² ≈ 100 MB de GPU; 4096 estoura memória no Quest
// ImageBitmap decodifica fora da thread principal; flipY tem de ser na criação (o WebGL ignora o do three).
const loader = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' })

interface Tile { f: string; x: number; y: number; n: number; tex: THREE.Texture }

/** Baixa e decodifica os tiles do nível z (índice em levels[] = pasta {z} do Marzipano). Tile que falha vira buraco. */
async function loadTiles(s: SceneData, z: number): Promise<Tile[]> {
  const { size, tileSize } = s.levels[z]
  const n = Math.ceil(size / tileSize)
  const jobs = Object.keys(FACE_ROT).flatMap((f) => Array.from({ length: n * n }, async (_, i) => {
    const x = i % n, y = Math.floor(i / n)
    try {
      const tex = new THREE.Texture(await loader.loadAsync(`${TOUR_URL}/tiles/${s.id}/${z}/${f}/${y}/${x}.jpg`))
      tex.colorSpace = THREE.SRGBColorSpace
      tex.generateMipmaps = false // ~1 texel por pixel no headset: mipmap só custaria memória e tempo
      tex.minFilter = THREE.LinearFilter
      tex.needsUpdate = true
      return { f, x, y, n, tex }
    } catch (err) {
      console.error('[XR] tile', s.id, f, y, x, err)
      return null
    }
  }))
  return (await Promise.all(jobs)).filter((t) => t !== null)
}
const dropTile = (tex: THREE.Texture) => { (tex.image as ImageBitmap).close(); tex.dispose() }

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
 * Sessão VR com three.js: cubo de tiles + hotspots de link e de info clicáveis por controle.
 * A cabeça (giroscópio do headset) vem do WebXR. Nada é baixado nem desenhado fora da sessão.
 */
export function initXR(onNavigate: (id: string) => void, onSession: (active: boolean) => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local')
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100)
  const hotspots = new THREE.Group()
  const sky = new THREE.Group() // 1 grupo por face, 1 plano por tile
  scene.add(sky, hotspots)
  const tileGeo = new THREE.PlaneGeometry(1, 1)

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
  let fadeTo = 1 // brilho-alvo do fundo: 0 escurece a cena que sai, 1 clareia a que entra
  let bright = 1
  let last = 0
  const anchor = new THREE.Vector2() // posição (x, z) da cabeça de onde se mede o passo
  const walk = new THREE.Vector2()
  const dir = new THREE.Vector3()
  const dir2 = new THREE.Vector2()
  let uploads: THREE.Texture[] = [] // texturas à espera de subir p/ a GPU, poucas por frame
  let uploaded: (() => void) | null = null

  const tileMats = () => sky.children.flatMap((g) => (g.children as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[]).map((m) => m.material))
  const clearSky = () => {
    for (const mat of tileMats()) { dropTile(mat.map!); mat.dispose() }
    sky.clear()
  }
  /** Solta quem espera a fila de upload (cena trocada ou sessão encerrada no meio). */
  const flushUploads = () => {
    uploads = []
    uploaded?.()
    uploaded = null
  }

  /** Mostra a cena (só dentro da sessão), direto no nível mais nítido que cabe na GPU (sem prévia borrada). */
  const enter = async (s: SceneData) => {
    const id = ++seq
    flushUploads()
    clearHotspots() // somem no clique; os da cena nova entram junto com a imagem dela
    const zs = s.levels.flatMap((l, z) => (l.fallbackOnly || l.size > MAX_FACE ? [] : [z]))
    // Transição suave: a cena que sai escurece enquanto a nova baixa e decodifica; todo o trabalho
    // de GPU (liberar a antiga, subir a nova) acontece no escuro, onde engasgo não aparece.
    fadeTo = 0
    const loading = loadTiles(s, zs.at(-1)!)
    await new Promise((r) => setTimeout(r, FADE_MS))
    if (id === seq) clearSky() // 1 cena na GPU por vez: o Quest 2 não aguenta duas
    const tiles = await loading
    const drop = () => tiles.forEach((t) => dropTile(t.tex))
    if (id !== seq) return drop() // trocou de cena ou saiu do VR durante a carga
    await new Promise<void>((r) => { uploads = tiles.map((t) => t.tex); uploaded = r })
    if (id !== seq) return drop()

    const faces = new Map<string, THREE.Group>()
    const w = (2 * SKY) / (tiles[0]?.n ?? 1)
    for (const t of tiles) {
      let g = faces.get(t.f)
      if (!g) {
        g = new THREE.Group()
        g.rotation.set(...FACE_ROT[t.f], 0)
        faces.set(t.f, g)
        sky.add(g)
      }
      const mat = new THREE.MeshBasicMaterial({ map: t.tex, depthWrite: false })
      mat.color.setScalar(bright)
      const mesh = new THREE.Mesh(tileGeo, mat)
      mesh.scale.setScalar(w * 1.002) // sobreposição mínima: sem fresta entre tiles
      mesh.position.set(-SKY + (t.x + 0.5) * w, SKY - (t.y + 0.5) * w, -SKY)
      g.add(mesh)
    }
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
    fadeTo = 1
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
  renderer.xr.addEventListener('sessionstart', () => {
    onSession(true)
    if (current) void enter(current)
  })
  renderer.xr.addEventListener('sessionend', () => {
    seq++
    flushUploads()
    clearHotspots()
    clearSky()
    onSession(false)
  })

  renderer.setAnimationLoop((time, frame?: XRFrame) => {
    if (!frame) return // fora da sessão VR não há o que desenhar (o canvas nem está no DOM)
    const step = Math.min(time - last, 100) / FADE_MS // fração do fade neste frame
    last = time
    if (bright !== fadeTo) {
      bright = THREE.MathUtils.clamp(bright + Math.sign(fadeTo - bright) * step, 0, 1)
      for (const mat of tileMats()) mat.color.setScalar(bright)
    }
    for (let i = 0; i < UPLOADS_PER_FRAME && uploads.length; i++) renderer.initTexture(uploads.pop()!)
    if (!uploads.length && uploaded) {
      uploaded()
      uploaded = null
    }
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace()!)
    if (pose) {
      // Foto 360 não tem profundidade: fundo e hotspots acompanham a posição da cabeça.
      // Só a rotação conta, então andar/inclinar não descola o hotspot da imagem.
      hotspots.position.copy(pose.transform.position)
      sky.position.copy(hotspots.position)
      if (face !== null) {
        const head = pose.transform.matrix // coluna 2 = eixo z da cabeça; o olhar é −z
        const turn = face - Math.atan2(-head[8], head[10])
        hotspots.rotation.y = turn
        sky.rotation.y = turn
        face = null
        anchor.set(hotspots.position.x, hotspots.position.z) // cena nova: o passo conta daqui
      }
      walk.set(hotspots.position.x - anchor.x, hotspots.position.z - anchor.y)
      const dist = walk.length()
      if (dist > WALK_STEP) {
        let target: string | undefined
        let best = WALK_CONE
        for (const h of hotspots.children) {
          if (!h.userData.target) continue
          dir.copy(h.position).applyAxisAngle(UP, hotspots.rotation.y) // direção do hotspot na sala
          const angle = walk.angleTo(dir2.set(dir.x, dir.z))
          if (angle < best) { best = angle; target = h.userData.target }
        }
        if (target) {
          anchor.set(hotspots.position.x, hotspots.position.z)
          onNavigate(target)
        } else {
          // Coleira: sem hotspot nessa direção (ou cena carregando), a âncora segue a cabeça,
          // então `walk` é sempre o passo mais recente e não o caminho todo desde a entrada.
          anchor.addScaledVector(walk, 1 - WALK_STEP / dist)
        }
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
