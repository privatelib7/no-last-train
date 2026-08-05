import { PrismaClient, LineColor } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 데모용 시드 — 로비에 보여줄 도시/노선
  const existing = await db.city.findFirst({ where: { name: '부산' } })
  if (existing) {
    console.log('시드 스킵: 부산 도시가 이미 있습니다.', existing.id)
    return
  }

  const player = await db.player.create({
    data: {
      token: '00000000-0000-4000-8000-000000000001',
      nickname: '데모',
    },
  })

  const city = await db.city.create({
    data: {
      name: '부산',
      seed: 42,
      seasonDay: 14,
      status: 'ACTIVE',
    },
  })

  const lineDefs: { color: LineColor; name: string; playerId?: string }[] = [
    { color: 'RED', name: '빨강 노선', playerId: player.id },
    { color: 'BLUE', name: '파랑 노선' },
    { color: 'GREEN', name: '초록 노선' },
    { color: 'YELLOW', name: '노랑 노선' },
  ]

  for (const line of lineDefs) {
    await db.line.create({
      data: {
        cityId: city.id,
        color: line.color,
        name: line.name,
        playerId: line.playerId,
        status: 'OPERATING',
      },
    })
  }

  console.log('시드 완료:', { cityId: city.id, playerToken: player.token })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
