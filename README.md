# template-xr-tour

TypeScript + Vite · Marzipano (tour 360) · three.js (WebXR) · getUserMedia.

```
npm install
npm run dev      # https://<ip>:5173 (cert autoassinado; Quest/celular precisam de HTTPS)
```

## Estrutura
- `public/tour/` — export do Marzipano: `data.json`, `img/`, `tiles/<cena>/…`. Troque pelo seu tour.
- `src/tour/tour.ts` — viewer Marzipano, cenas, hotspots de link/info.
- `src/tour/gyro.ts` — giroscópio (celular em pé).
- `src/xr/xr.ts` — sessão `immersive-vr` com three.js (cubo costurado dos tiles + hotspots clicáveis por controle). Carregado sob demanda.
- `src/media/camera.ts` — `startCamera()` / `captureFrame()` (getUserMedia).

## Limites
- VR costura os tiles até 2048px/face (4096 estoura memória no Quest).
- Passthrough/câmera dentro da sessão imersiva do Quest não é exposto via getUserMedia.
