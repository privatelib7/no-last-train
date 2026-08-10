// 재배포가 제한된 오디오 에셋을 빌드 시점에 원본에서 내려받는다.
//
// Mixkit Sound Effects Free License는 음원을 "on its own, as stock, in a tool or
// template, or with source files" 재배포하는 것을 금지한다. 저장소가 공개라
// 원본 파일을 커밋해 두면 이 조항에 걸리므로, 파일은 .gitignore로 빼고
// 빌드·개발 서버를 띄우기 전에 이 스크립트로 받아온다.
//
// 이미 받아둔 파일이 체크섬까지 맞으면 네트워크를 타지 않으므로,
// 오프라인에서도 한 번 받아둔 뒤에는 그대로 빌드할 수 있다.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const AUDIO_ASSETS = [
  {
    // 목표 달성 효과음. 라이선스 고지는 client/src/lib/licenses.ts 참고.
    path: 'client/public/audio/mixkit-unlock-new-item-game-notification-254.wav',
    url: 'https://assets.mixkit.co/active_storage/sfx/254/254.wav',
    sha256: 'f1ad83a5d55073c09b4f9bf2a9f75813212b227cea7582451aba033da5654d55',
    bytes: 419586,
  },
]

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 이미 받아둔 파일이 매니페스트와 일치하는지 확인한다. 없거나 다르면 false. */
export async function isUpToDate(asset, root = repoRoot) {
  try {
    return sha256(await readFile(join(root, asset.path))) === asset.sha256
  } catch {
    return false
  }
}

async function download(asset) {
  const response = await fetch(asset.url)
  if (!response.ok) {
    throw new Error(`${asset.url} 응답이 ${response.status} ${response.statusText} 입니다`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  // 빌드마다 외부에서 받아오는 파일이므로 내용이 바뀌지 않았는지 반드시 확인한다.
  const actual = sha256(buffer)
  if (actual !== asset.sha256) {
    throw new Error(
      `체크섬이 다릅니다. 예상 ${asset.sha256}, 실제 ${actual} (${buffer.byteLength} bytes).\n` +
        '원본이 교체되었을 수 있습니다. 음원을 직접 확인한 뒤 매니페스트를 갱신하세요.',
    )
  }

  return buffer
}

async function main() {
  for (const asset of AUDIO_ASSETS) {
    if (await isUpToDate(asset)) {
      console.log(`[audio] 최신 상태 ${asset.path}`)
      continue
    }

    const target = join(repoRoot, asset.path)
    try {
      const buffer = await download(asset)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      console.log(`[audio] 내려받음 ${asset.path} (${buffer.byteLength} bytes)`)
    } catch (error) {
      console.error(`[audio] ${asset.path} 준비 실패: ${error.message}`)
      console.error(`[audio] 원본: ${asset.url}`)
      process.exitCode = 1
      return
    }
  }
}

// 테스트에서 import할 때는 실행하지 않는다.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
