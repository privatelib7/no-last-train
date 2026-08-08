// Next CLI에 .env의 PORT를 전달하기 위한 래퍼.
//
// Next는 포트를 commander의 `.env('PORT')`로 process.env에서만 읽는데,
// 인자 파싱(dist/bin/next의 program.parse)이 .env 파일 로딩보다 먼저 일어난다.
// 그래서 server/.env에 PORT를 써도 CLI에는 도달하지 않는다.
// Node의 --env-file로 .env를 미리 주입한 뒤 next를 실행해 이 간극을 메운다.
// (NODE_OPTIONS로는 --env-file이 허용되지 않아 자식 프로세스로 띄운다.)
//
// 우선순위: 셸 환경변수 > server/.env > Next 기본값(3000)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next')

const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', nextBin, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)

child.on('exit', (code, signal) => {
  // 시그널로 종료된 경우 같은 시그널로 죽어야 셸이 상태를 올바르게 인식한다.
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
