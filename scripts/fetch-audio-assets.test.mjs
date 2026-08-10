import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { AUDIO_ASSETS, isUpToDate, sha256 } from './fetch-audio-assets.mjs'

test('오디오 에셋 매니페스트가 빠짐없이 채워져 있다', () => {
  assert.ok(AUDIO_ASSETS.length > 0)

  for (const asset of AUDIO_ASSETS) {
    assert.match(asset.path, /^client\/public\/audio\/[^/]+$/)
    assert.match(asset.url, /^https:\/\//)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(asset.bytes) && asset.bytes > 0)
  }
})

test('내려받은 파일은 체크섬이 맞을 때만 최신으로 본다', async () => {
  const [asset] = AUDIO_ASSETS
  const root = await mkdtemp(join(tmpdir(), 'nlt-audio-'))
  const target = join(root, asset.path)
  await mkdir(dirname(target), { recursive: true })

  // 파일이 아직 없는 상태
  assert.equal(await isUpToDate(asset, root), false)

  // 내용이 다른 파일이 놓인 상태 — 다시 받아야 한다
  await writeFile(target, Buffer.from('다른 내용'))
  assert.equal(await isUpToDate(asset, root), false)

  // 체크섬이 맞는 파일이 놓인 상태
  const buffer = Buffer.alloc(asset.bytes)
  await writeFile(target, buffer)
  assert.equal(
    await isUpToDate({ ...asset, sha256: sha256(buffer) }, root),
    true,
  )
})
