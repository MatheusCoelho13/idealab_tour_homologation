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

// Giroscópio, sem botão, em qualquer aparelho que tenha o sensor (celular, Quest fora do VR).
// iOS só libera o sensor após um gesto, então lá liga no 1º toque; nos demais liga já.
// Captura 'touchend' porque o Marzipano consome o toque e o 'click' nunca chega.
if ('DeviceOrientationEvent' in window) {
  if ('requestPermission' in DeviceOrientationEvent) addEventListener('touchend', () => void toggleGyro(tour), { once: true, capture: true })
  else void toggleGyro(tour)
}
