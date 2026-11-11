import './style.css'
import { createTour } from './tour/tour'
import { toggleGyro } from './tour/gyro'
import { TOUR_URL, type TourData } from './types'

const data: TourData = await (await fetch(`${TOUR_URL}/data.json`)).json()
const tour = createTour(document.getElementById('pano')!, data)

// WebXR (three só é baixado se o aparelho suporta VR imersivo)
if (await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false)) {
  const { initXR } = await import('./xr/xr')
  const xr = initXR(tour.goTo)
  tour.onChange(xr.setScene)
  xr.setScene(tour.scene)
}

// Giroscópio (celular), sem botão: liga no 1º toque (iOS só libera sensor após gesto).
// Computador e Quest ficam no arrastar; no Quest a cabeça é rastreada dentro do VR (xr.ts).
if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  addEventListener('click', () => void toggleGyro(tour), { once: true })
