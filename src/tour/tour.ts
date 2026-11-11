import Marzipano from 'marzipano'
import { TOUR_URL, type InfoHotspot, type SceneData, type TourData } from '../types'

type MScene = ReturnType<InstanceType<typeof Marzipano.Viewer>['createScene']>

export function createTour(el: HTMLElement, data: TourData) {
  const viewer = new Marzipano.Viewer(el)
  const cache = new Map<string, MScene>() // hotspots ficam na cena => criados 1x
  const listeners: ((s: SceneData) => void)[] = []
  let current = data.scenes[0]

  const build = (s: SceneData): MScene => {
    const source = Marzipano.ImageUrlSource.fromString(`${TOUR_URL}/tiles/${s.id}/{z}/{f}/{y}/{x}.jpg`)
    const limiter = Marzipano.RectilinearView.limit.traditional(s.faceSize, (120 * Math.PI) / 180)
    const view = new Marzipano.RectilinearView(s.initialViewParameters, limiter)
    const scene = viewer.createScene({ source, geometry: new Marzipano.CubeGeometry(s.levels), view })
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

  const goTo = (id: string) => {
    const s = data.scenes.find((x) => x.id === id)
    if (!s) return console.error('Cena não encontrada:', id)
    let scene = cache.get(id)
    if (!scene) cache.set(id, (scene = build(s)))
    scene.switchTo()
    current = s
    listeners.forEach((fn) => fn(s))
  }

  goTo(current.id)

  return {
    goTo,
    get scene() { return current },
    view: () => cache.get(current.id)!.view(),
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
