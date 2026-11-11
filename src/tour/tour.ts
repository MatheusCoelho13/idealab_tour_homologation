import Marzipano from 'marzipano'
import { TOUR_URL, type InfoHotspot, type SceneData, type TourData } from '../types'

type MScene = ReturnType<InstanceType<typeof Marzipano.Viewer>['createScene']>

export function createTour(el: HTMLElement, data: TourData) {
  const viewer = new Marzipano.Viewer(el)
  const cache = new Map<string, MScene>() // hotspots ficam na cena => criados 1x
  const listeners: ((s: SceneData) => void)[] = []
  let current = data.scenes[0]

  const build = (s: SceneData): MScene => {
    // Só o nível mais nítido: sem prévia borrada nem níveis intermediários (pasta = índice em levels[]).
    const top = s.levels.length - 1
    const source = Marzipano.ImageUrlSource.fromString(`${TOUR_URL}/tiles/${s.id}/${top}/{f}/{y}/{x}.jpg`)
    const limiter = Marzipano.RectilinearView.limit.traditional(s.faceSize, (120 * Math.PI) / 180)
    const view = new Marzipano.RectilinearView(s.initialViewParameters, limiter)
    const scene = viewer.createScene({ source, geometry: new Marzipano.CubeGeometry([s.levels[top]]), view })
    const hs = scene.hotspotContainer()
    for (const h of s.linkHotspots) hs.createHotspot(linkEl(h.target), h)
    for (const h of s.infoHotspots) hs.createHotspot(infoEl(h), h)
    return scene
  }

  const linkEl = (target: string) => {
    const el = document.createElement('div')
    el.className = 'hotspot-link'
    el.innerHTML = `<img src="${TOUR_URL}/img/link.png" alt="">`
    el.addEventListener('click', (e) => { e.stopPropagation(); goTo(target) })
    return el
  }

  // O switchTo() já faz crossfade de 1 s, mas só fica suave se os tiles da cena nova já estiverem
  // no cache HTTP; senão o fade abre numa cena preta. Por isso as vizinhas são baixadas antes do clique.
  // Fila de 2 downloads em baixa prioridade: disparar tudo de uma vez (até 480 imagens) disputava
  // rede com a cena atual e travava. Trocar de cena descarta o que sobrou da fila anterior.
  const queue: string[] = []
  let active = 0
  const pump = () => {
    while (active < 2 && queue.length) {
      const img = new Image()
      active++
      img.onload = img.onerror = () => { active--; pump() }
      img.fetchPriority = 'low'
      img.src = queue.shift()!
    }
  }
  const preload = (s: SceneData) => {
    const top = s.levels.length - 1
    const n = Math.ceil(s.levels[top].size / s.levels[top].tileSize)
    for (const f of 'fblrud') for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      queue.push(`${TOUR_URL}/tiles/${s.id}/${top}/${f}/${y}/${x}.jpg`)
  }

  // Em pausa (sessão VR aberta) o 2D não troca de cena nem baixa nada: ninguém o vê, e no Quest
  // ele disputaria rede e GPU com o VR. Ao sair da pausa, mostra a cena em que o VR parou.
  let paused = false
  let shown: SceneData | undefined
  const show = (s: SceneData) => {
    if (shown === s) return
    shown = s
    let scene = cache.get(s.id)
    if (!scene) cache.set(s.id, (scene = build(s)))
    scene.switchTo()
    queue.length = 0
    for (const h of s.linkHotspots) {
      const next = data.scenes.find((x) => x.id === h.target)
      if (next) preload(next)
    }
    setTimeout(pump, 1500) // deixa a cena atual carregar primeiro
  }

  const goTo = (id: string) => {
    const s = data.scenes.find((x) => x.id === id)
    if (!s) return console.error('Cena não encontrada:', id)
    current = s
    if (!paused) show(s)
    listeners.forEach((fn) => fn(s))
  }

  goTo(current.id)

  return {
    goTo,
    get scene() { return current },
    view: () => cache.get(shown!.id)!.view(),
    setPaused(p: boolean) {
      paused = p
      if (p) queue.length = 0
      else show(current)
    },
    onChange: (fn: (s: SceneData) => void) => void listeners.push(fn),
  }
}

export type Tour = ReturnType<typeof createTour>

function infoEl({ title, text }: InfoHotspot) {
  const el = document.createElement('div')
  el.className = 'hotspot-info'
  const label = document.createElement('div')
  // textContent (não innerHTML): data.json pode vir de fora
  if (title) label.append(Object.assign(document.createElement('strong'), { textContent: title }))
  if (title && text) label.append(document.createElement('br'))
  if (text) label.append(text)
  // rolar o texto não pode virar zoom/arrasto do panorama
  for (const ev of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'mousedown'])
    label.addEventListener(ev, (e) => e.stopPropagation())
  el.append(Object.assign(document.createElement('span'), { textContent: 'i' }), label)
  el.addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('open') })
  return el
}
