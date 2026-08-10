/**
 * 아무도 관제실을 보고 있지 않아도(요청이 안 옴) 실시간에 맞춰 도시 틱이 계속
 * 진행되도록 하는 배경 하트비트. pm2로 nlt-server와 별도 프로세스로 띄운다.
 * 이게 없으면 오래 자리를 비운 뒤 다시 들어왔을 때 밀린 틱을 한꺼번에 따라잡아야 해서
 * 차량이 잠깐 순간이동/급가속하는 것처럼 보인다 — 이제는 다시 들어왔을 때 이미
 * 정확한 실시간 위치에서 시작한다.
 *
 *   npx tsx scripts/tick-loop.ts
 */
import { tickAllActiveCities } from '../src/lib/simulation'
import { SIM } from '../src/types/game'

let running = false

async function tick() {
  if (running) return
  running = true
  try {
    await tickAllActiveCities()
  } catch (err) {
    console.error('[tick-loop] tickAllActiveCities failed', err)
  } finally {
    running = false
  }
}

console.log(`[tick-loop] started, interval=${SIM.LIVE_TICK_MS}ms`)
setInterval(() => { void tick() }, SIM.LIVE_TICK_MS)
void tick()
