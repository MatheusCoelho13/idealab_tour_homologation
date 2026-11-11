import type { Tour } from './tour'

type IOSOrientation = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }

let handler: ((e: DeviceOrientationEvent) => void) | null = null

/** Liga/desliga giroscópio. Retorna o novo estado. Chamar a partir de um clique (iOS exige gesto). */
export async function toggleGyro(tour: Tour): Promise<boolean> {
  if (handler) {
    removeEventListener('deviceorientation', handler)
    handler = null
    return false
  }
  const req = (DeviceOrientationEvent as IOSOrientation).requestPermission
  if (req && (await req.call(DeviceOrientationEvent)) !== 'granted') return false

  // Soma a variação do sensor à vista (em vez de impor o ângulo absoluto): arrastar continua valendo
  // e aparelho parado não mexe em nada. Sem sensor (PC) o evento vem com alpha nulo e é ignorado.
  // ponytail: assume aparelho em pé (retrato). Paisagem pede compensar screen.orientation.
  const RAD = Math.PI / 180
  let prev: { alpha: number; beta: number } | null = null
  handler = (e) => {
    if (e.alpha == null || e.beta == null) return
    if (prev) {
      const view = tour.view()
      // alpha cresce girando p/ esquerda; o módulo trata a volta 359° -> 0°
      view.setYaw(view.yaw() + ((((prev.alpha - e.alpha + 540) % 360) - 180) * RAD))
      // beta cresce ao apontar p/ cima; pitch do Marzipano é positivo p/ baixo
      view.setPitch(view.pitch() - (e.beta - prev.beta) * RAD)
    }
    prev = { alpha: e.alpha, beta: e.beta }
  }
  addEventListener('deviceorientation', handler)
  return true
}
