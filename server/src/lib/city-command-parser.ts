import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { isVehicleInService } from './vehicle-service'

export type CityCommandStation = {
  id: string
  name: string
  posX: number
  posY: number
}

export type CityCommandVehicle = {
  id: string
  status: 'OPERATING' | 'SPARE' | 'LOANED' | 'MAINTENANCE' | 'BROKEN'
  isSpare: boolean
}

export type CityCommandLine = {
  id: string
  name: string
  mode: 'SUBWAY' | 'BUS'
  status: 'OPERATING' | 'DEGRADED' | 'SUSPENDED'
  stations: CityCommandStation[]
  vehicles: CityCommandVehicle[]
}

export type CityCommandContext = {
  stations: CityCommandStation[]
  lines: CityCommandLine[]
}

export type CityCommandAction =
  | { type: 'BUILD_STATION'; name: string; posX: number; posY: number }
  | { type: 'CREATE_LINE'; mode: 'SUBWAY' | 'BUS' }
  | {
      type: 'CREATE_CONNECTED_LINE'
      mode: 'SUBWAY' | 'BUS'
      fromStationId: string
      toStationId: string
    }
  | { type: 'REMOVE_LINE'; lineId: string }
  | {
      type: 'BUILD_SEGMENT'
      lineId: string
      fromStationId: string
      toStationId: string
    }
  | {
      type: 'INSERT_STATION'
      lineId: string
      fromStationId: string
      toStationId: string
      stationId: string
    }
  | { type: 'DETACH_STATION'; lineId: string; stationId: string }
  | { type: 'REMOVE_STATION'; stationId: string }
  | { type: 'RENAME_STATION'; stationId: string; name: string }
  | {
      type: 'SET_LINE_STATUS'
      lineId: string
      status: 'OPERATING' | 'SUSPENDED'
    }
  | { type: 'BUY_VEHICLE'; lineId: string; count: number }
  | { type: 'SET_VEHICLE_SERVICE'; lineId: string; vehicleId: string; inService: boolean }
  | { type: 'TRANSFER_VEHICLE'; lineId: string; vehicleId: string; targetLineId: string }
  | { type: 'REMOVE_VEHICLE'; lineId: string; vehicleId: string }

export type CityCommandPlanResult =
  | { ok: true; summary: string; actions: CityCommandAction[] }
  | { ok: false; reason: string; suggestion: string }

// 한 번의 입력으로 처리할 명령 수와, 그 명령이 펼쳐낼 수 있는 액션 수 상한.
// "모든 차량 투입"처럼 일괄 명령 하나가 여러 액션으로 펼쳐지므로 둘을 따로 제한한다.
const MAX_PLAN_COMMANDS = 4
const MAX_PLAN_ACTIONS = 20

// 두 역 사이에 새 역을 끼워 넣으려면 최소한 이만큼(맵 단위)은 떨어져 있어야 한다.
const MIN_NEW_STATION_GAP = 6

const CommandIntentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('BUILD_STATION_BETWEEN'),
    fromStationName: z.string().min(1),
    toStationName: z.string().min(1),
    // 사용자가 새 역 이름을 말하지 않았으면 null — 서버가 "신설역 N"을 붙인다.
    newStationName: z.string().trim().max(12).nullable(),
  }),
  z.object({
    type: z.literal('CREATE_EMPTY_LINE'),
    mode: z.enum(['SUBWAY', 'BUS']),
  }),
  z.object({
    type: z.literal('CREATE_LINE_BETWEEN_STATIONS'),
    mode: z.enum(['SUBWAY', 'BUS']),
    fromStationName: z.string().min(1),
    toStationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('REMOVE_LINE'),
    lineName: z.string().min(1),
  }),
  z.object({
    type: z.literal('EXTEND_LINE_TO_STATION'),
    lineName: z.string().min(1),
    stationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('INSERT_STATION_BETWEEN'),
    lineName: z.string().min(1),
    fromStationName: z.string().min(1),
    toStationName: z.string().min(1),
    stationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('DETACH_STATION'),
    lineName: z.string().min(1),
    stationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('REMOVE_STATION'),
    stationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('RENAME_STATION'),
    stationName: z.string().min(1),
    newStationName: z.string().trim().min(1).max(12),
  }),
  z.object({
    type: z.literal('SET_LINE_STATUS'),
    lineName: z.string().min(1),
    status: z.enum(['OPERATING', 'SUSPENDED']),
  }),
  z.object({
    type: z.literal('SET_ALL_LINES_STATUS'),
    status: z.enum(['OPERATING', 'SUSPENDED']),
  }),
  z.object({
    type: z.literal('BUY_VEHICLE'),
    lineName: z.string().min(1),
    count: z.number().int().min(1).max(3),
  }),
  z.object({
    type: z.literal('SET_ALL_VEHICLES_SERVICE'),
    // null = 도시의 모든 노선
    lineName: z.string().nullable(),
    inService: z.boolean(),
  }),
  z.object({
    type: z.literal('SET_VEHICLE_SERVICE'),
    lineName: z.string().min(1),
    vehicleNumber: z.number().int().positive(),
    inService: z.boolean(),
  }),
  z.object({
    type: z.literal('TRANSFER_VEHICLE'),
    lineName: z.string().min(1),
    vehicleNumber: z.number().int().positive(),
    targetLineName: z.string().min(1),
  }),
  z.object({
    type: z.literal('REMOVE_VEHICLE'),
    lineName: z.string().min(1),
    vehicleNumber: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('UNSUPPORTED'),
  }),
])

const AiCommandResponseSchema = z.object({
  commands: z.array(CommandIntentSchema).min(1).max(MAX_PLAN_COMMANDS),
})

type CommandIntent = Exclude<z.infer<typeof CommandIntentSchema>, { type: 'UNSUPPORTED' }>

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-nano'
const client = apiKey && !apiKey.includes('...')
  ? new OpenAI({ apiKey, timeout: 8_000, maxRetries: 0 })
  : null

const SYSTEM_PROMPT = `
당신은 도시 교통 운영 게임의 명령 해석기입니다.
사용자의 한국어 명령을 아래 command 객체로 변환해 commands 배열에 담으세요.
한 문장에 서로 다른 작업이 여러 개 있으면 말한 순서대로 최대 ${MAX_PLAN_COMMANDS}개까지 나눠 담습니다.

지원 명령:
1. 빈 노선 생성: CREATE_EMPTY_LINE(mode)
2. 두 기존 역 사이 새 노선 건설: CREATE_LINE_BETWEEN_STATIONS(mode, fromStationName, toStationName)
3. 기존 노선 삭제: REMOVE_LINE(lineName)
4. 기존 노선을 기존 역 방향으로 연장: EXTEND_LINE_TO_STATION(lineName, stationName)
5. 노선의 이웃한 두 역 사이에 다른 기존 역 삽입: INSERT_STATION_BETWEEN(lineName, fromStationName, toStationName, stationName)
6. 특정 노선에서 역만 제외: DETACH_STATION(lineName, stationName)
7. 도시에서 역 완전 삭제: REMOVE_STATION(stationName)
8. 역 이름 변경: RENAME_STATION(stationName, newStationName)
9. 노선 운행 중단 또는 재개: SET_LINE_STATUS(lineName, status=OPERATING|SUSPENDED)
10. 노선의 N번 차량 운행 또는 입고: SET_VEHICLE_SERVICE(lineName, vehicleNumber, inService)
11. 노선의 N번 차량을 다른 노선 차고지로 이동: TRANSFER_VEHICLE(lineName, vehicleNumber, targetLineName)
12. 노선의 N번 차량 제거: REMOVE_VEHICLE(lineName, vehicleNumber)
13. 기존 두 역 사이에 새 역 신설: BUILD_STATION_BETWEEN(fromStationName, toStationName, newStationName)
14. 노선 차고지에 차량 구매(증차): BUY_VEHICLE(lineName, count)
15. 모든 노선 일괄 중단 또는 재개: SET_ALL_LINES_STATUS(status)
16. 한 노선 또는 도시 전체 차량 일괄 운행·입고: SET_ALL_VEHICLES_SERVICE(lineName, inService)

규칙:
- 제공된 역과 노선 이름만 그대로 사용하세요. ID, 좌표, 공사비는 만들지 마세요.
- 차량 번호는 각 노선에 표시된 1부터 시작하는 번호입니다.
- 사용자가 버스를 명시하지 않은 새 노선은 SUBWAY입니다.
- 삭제, 제거, 철거, 폐기처럼 파괴적인 동사를 명시하지 않았다면 REMOVE_*로 분류하지 마세요.
- "노선에서 역을 빼기"와 "도시에서 역을 완전히 삭제하기"를 구분하세요.
- 이미 있는 역을 노선에 태우는 것은 INSERT_STATION_BETWEEN, 없던 역을 새로 짓는 것은 BUILD_STATION_BETWEEN입니다.
- BUILD_STATION_BETWEEN의 newStationName은 사용자가 이름을 말했을 때만 채우고, 아니면 null로 두세요.
- 특정 차량 번호 없이 "전부·모두·다"로 지시하면 SET_ALL_* 명령을 쓰세요. SET_ALL_VEHICLES_SERVICE의 lineName은 도시 전체면 null입니다.
- BUY_VEHICLE의 count는 사용자가 말한 대수이고, 말하지 않았으면 1입니다.
- 지원하지 않거나 대상이 불명확한 명령은 UNSUPPORTED로 분류하세요.
`.trim()

export async function parseCityCommand(
  rawInput: string,
  context: CityCommandContext,
): Promise<CityCommandPlanResult> {
  const fallbackIntent = inferFallbackIntent(rawInput, context)
  let aiFailure: CityCommandPlanResult | null = null

  if (client) {
    try {
      const intents = await parseWithAi(rawInput, context)
      if (intents) {
        const resolved = resolveCityCommandPlan(intents, context, rawInput)
        if (resolved.ok) return resolved
        aiFailure = resolved
      }
    } catch {
      // 모델 호출이 실패해도 명시적인 핵심 명령은 로컬 해석기로 계속 동작한다.
    }
  }

  if (fallbackIntent) return resolveCityCommandPlan([fallbackIntent], context, rawInput)
  if (aiFailure) return aiFailure

  return {
    ok: false,
    reason: '명령에서 작업 종류나 대상을 정확히 찾지 못했습니다.',
    suggestion: buildSuggestion(context),
  }
}

export function planFallbackCityCommand(
  rawInput: string,
  context: CityCommandContext,
): CityCommandPlanResult {
  const intent = inferFallbackIntent(rawInput, context)
  if (!intent) {
    return {
      ok: false,
      reason: '지원하는 도시 운영 명령을 인식하지 못했습니다.',
      suggestion: buildSuggestion(context),
    }
  }
  return resolveCityCommandPlan([intent], context, rawInput)
}

// 여러 명령을 실행 전 도시 상태 기준으로 각각 해석해 하나의 실행 계획으로 합친다.
// 하나라도 실패하면 절반만 실행되는 일이 없도록 계획 전체를 취소한다.
function resolveCityCommandPlan(
  intents: CommandIntent[],
  context: CityCommandContext,
  rawInput: string,
): CityCommandPlanResult {
  const summaries: string[] = []
  const actions: CityCommandAction[] = []

  for (const intent of intents.slice(0, MAX_PLAN_COMMANDS)) {
    const resolved = resolveCityCommandIntent(intent, context, rawInput)
    if (!resolved.ok) return resolved
    summaries.push(resolved.summary)
    actions.push(...resolved.actions)
  }

  if (actions.length === 0) {
    return commandFailure('실행할 작업을 찾지 못했습니다.', buildSuggestion(context))
  }
  if (actions.length > MAX_PLAN_ACTIONS) {
    return commandFailure(
      `한 번에 실행할 수 있는 작업은 ${MAX_PLAN_ACTIONS}개까지입니다. (요청 ${actions.length}개)`,
      '노선이나 대상을 좁혀서 나눠 명령해주세요.',
    )
  }

  return { ok: true, summary: summaries.join(' '), actions }
}

async function parseWithAi(rawInput: string, context: CityCommandContext): Promise<CommandIntent[] | null> {
  if (!client) return null

  const stationList = context.stations.map(station => station.name).join(', ')
  const lineList = context.lines.map(line => {
    const endpoints = line.stations.length > 0
      ? `${line.stations[0].name}–${line.stations[line.stations.length - 1].name}`
      : '연결 역 없음'
    const vehicles = line.vehicles.map((vehicle, index) => {
      const service = vehicle.status === 'OPERATING' && !vehicle.isSpare ? '운행' : '차고지/기타'
      return `${index + 1}번:${service}`
    }).join(', ')
    return `${line.name}(${line.mode}, ${endpoints}, 차량 ${vehicles || '없음'})`
  }).join(', ')

  const response = await client.responses.parse({
    model,
    max_output_tokens: 600,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `역: ${stationList}\n노선: ${lineList}\n명령: ${rawInput}`,
      },
    ],
    text: {
      format: zodTextFormat(AiCommandResponseSchema, 'city_command_intent'),
    },
  })
  const parsed = response.output_parsed?.commands
  if (!parsed || parsed.length === 0) return null
  // 하나라도 해석하지 못한 부분이 있으면 나머지만 몰래 실행하지 않고 로컬 해석기에 넘긴다.
  if (parsed.some(command => command.type === 'UNSUPPORTED')) return null
  return parsed as CommandIntent[]
}

function resolveCityCommandIntent(
  intent: CommandIntent,
  context: CityCommandContext,
  rawInput: string,
): CityCommandPlanResult {
  if (intent.type === 'CREATE_EMPTY_LINE') {
    const modeLabel = intent.mode === 'BUS' ? '버스' : '지하철'
    return {
      ok: true,
      summary: `새 ${modeLabel} 노선을 만듭니다.`,
      actions: [{ type: 'CREATE_LINE', mode: intent.mode }],
    }
  }

  if (intent.type === 'CREATE_LINE_BETWEEN_STATIONS') {
    const from = findStation(context, intent.fromStationName)
    const to = findStation(context, intent.toStationName)
    if (!from || !to) return unresolvedTarget('역', context)
    if (from.id === to.id) {
      return commandFailure('새 노선을 만들려면 서로 다른 두 역이 필요합니다.', buildSuggestion(context))
    }
    const modeLabel = intent.mode === 'BUS' ? '버스' : '지하철'
    return {
      ok: true,
      summary: `${from.name}–${to.name} 사이에 새 ${modeLabel} 노선을 건설합니다.`,
      actions: [{
        type: 'CREATE_CONNECTED_LINE',
        mode: intent.mode,
        fromStationId: from.id,
        toStationId: to.id,
      }],
    }
  }

  if (intent.type === 'BUILD_STATION_BETWEEN') {
    const from = findStation(context, intent.fromStationName)
    const to = findStation(context, intent.toStationName)
    if (!from || !to) return unresolvedTarget('역', context)
    if (from.id === to.id) {
      return commandFailure('새 역을 놓을 기준이 되는 서로 다른 두 역이 필요합니다.', buildSuggestion(context))
    }
    if (distance(from, to) < MIN_NEW_STATION_GAP) {
      return commandFailure(
        `${from.name}과 ${to.name}이 너무 가까워 사이에 역을 지을 자리가 없습니다.`,
        '조금 더 떨어진 두 역을 기준으로 요청하거나, 지도에서 직접 역을 지어주세요.',
      )
    }
    const requestedName = intent.newStationName?.trim() ?? ''
    if (requestedName && context.stations.some(item => normalize(item.name) === normalize(requestedName))) {
      return commandFailure(`${requestedName} 이름을 가진 역이 이미 있습니다.`, '겹치지 않는 새 역 이름을 입력해주세요.')
    }
    const name = requestedName || nextNewStationName(context)
    return {
      ok: true,
      summary: `${from.name}과 ${to.name} 사이에 ${name}을 새로 건설합니다.`,
      actions: [{
        type: 'BUILD_STATION',
        name,
        posX: clampMapX((from.posX + to.posX) / 2),
        posY: clampMapY((from.posY + to.posY) / 2),
      }],
    }
  }

  if (intent.type === 'SET_ALL_LINES_STATUS') {
    if (context.lines.length === 0) {
      return commandFailure('도시에 운영 중인 노선이 없습니다.', '먼저 노선을 만든 뒤 다시 명령해주세요.')
    }
    const targets = context.lines.filter(line => line.status !== intent.status)
    if (targets.length === 0) {
      const state = intent.status === 'SUSPENDED' ? '중단' : '운행'
      return commandFailure(`이미 모든 노선이 ${state} 상태입니다.`, '상태를 바꿀 노선이 없습니다.')
    }
    const verb = intent.status === 'SUSPENDED' ? '운행을 중단' : '운행을 재개'
    return {
      ok: true,
      summary: `${targets.map(line => line.name).join(', ')} ${targets.length}개 노선의 ${verb}합니다.`,
      actions: targets.map(line => ({
        type: 'SET_LINE_STATUS' as const,
        lineId: line.id,
        status: intent.status,
      })),
    }
  }

  if (intent.type === 'SET_ALL_VEHICLES_SERVICE') {
    const scopedLine = intent.lineName ? findLine(context, intent.lineName) : null
    if (intent.lineName && !scopedLine) return unresolvedTarget('노선', context)
    const scope = scopedLine ? [scopedLine] : context.lines
    const actions = scope.flatMap(line => {
      // 운행 투입은 역이 연결된 노선에서만 가능하다.
      if (intent.inService && line.stations.length === 0) return []
      return line.vehicles
        .filter(vehicle => isVehicleInService(vehicle) !== intent.inService)
        .filter(vehicle => (intent.inService ? vehicle.isSpare && vehicle.status === 'SPARE' : true))
        .map(vehicle => ({
          type: 'SET_VEHICLE_SERVICE' as const,
          lineId: line.id,
          vehicleId: vehicle.id,
          inService: intent.inService,
        }))
    })
    if (actions.length === 0) {
      const state = intent.inService ? '운행 중' : '차고지 대기'
      const where = scopedLine ? `${scopedLine.name}의` : '도시의'
      return commandFailure(`${where} 차량이 이미 모두 ${state}입니다.`, '상태를 바꿀 차량이 없습니다.')
    }
    const verb = intent.inService ? '운행에 투입' : '차고지에 입고'
    const where = scopedLine ? `${scopedLine.name} ` : '도시 전체 '
    return {
      ok: true,
      summary: `${where}차량 ${actions.length}대를 ${verb}합니다.`,
      actions,
    }
  }

  if (intent.type === 'REMOVE_STATION') {
    if (!hasExplicitRemovalVerb(rawInput)) return explicitRemovalRequired('역')
    const station = findStation(context, intent.stationName)
    if (!station) return unresolvedTarget('역', context)
    return {
      ok: true,
      summary: `${station.name}을 도시에서 완전히 삭제합니다.`,
      actions: [{ type: 'REMOVE_STATION', stationId: station.id }],
    }
  }

  if (intent.type === 'RENAME_STATION') {
    const station = findStation(context, intent.stationName)
    if (!station) return unresolvedTarget('역', context)
    const newName = intent.newStationName.trim()
    if (normalize(station.name) === normalize(newName)) {
      return commandFailure(`${station.name}의 현재 이름과 새 이름이 같습니다.`, '다른 역 이름을 입력해주세요.')
    }
    const duplicate = context.stations.some(item => item.id !== station.id && normalize(item.name) === normalize(newName))
    if (duplicate) return commandFailure(`${newName} 이름을 가진 역이 이미 있습니다.`, '겹치지 않는 새 이름을 입력해주세요.')
    return {
      ok: true,
      summary: `${station.name}의 이름을 ${newName}(으)로 변경합니다.`,
      actions: [{ type: 'RENAME_STATION', stationId: station.id, name: newName }],
    }
  }

  if (intent.type === 'TRANSFER_VEHICLE') {
    const line = findLine(context, intent.lineName)
    const targetLine = findLine(context, intent.targetLineName)
    if (!line || !targetLine) return unresolvedTarget('노선', context)
    if (line.id === targetLine.id) {
      return commandFailure('같은 노선 차고지로는 차량을 이동할 수 없습니다.', '서로 다른 출발 노선과 도착 노선을 지정해주세요.')
    }
    const vehicle = line.vehicles[intent.vehicleNumber - 1]
    if (!vehicle) return unresolvedVehicle(line, intent.vehicleNumber)
    return {
      ok: true,
      summary: `${line.name} ${intent.vehicleNumber}번 차량을 ${targetLine.name} 차고지로 이동합니다.`,
      actions: [{
        type: 'TRANSFER_VEHICLE',
        lineId: line.id,
        vehicleId: vehicle.id,
        targetLineId: targetLine.id,
      }],
    }
  }

  const line = findLine(context, intent.lineName)
  if (!line) return unresolvedTarget('노선', context)

  if (intent.type === 'REMOVE_LINE') {
    if (!hasExplicitRemovalVerb(rawInput)) return explicitRemovalRequired('노선')
    return {
      ok: true,
      summary: `${line.name} 노선을 삭제합니다.`,
      actions: [{ type: 'REMOVE_LINE', lineId: line.id }],
    }
  }

  if (intent.type === 'BUY_VEHICLE') {
    return {
      ok: true,
      summary: `${line.name} 차고지에 차량 ${intent.count}대를 들입니다.`,
      actions: [{ type: 'BUY_VEHICLE', lineId: line.id, count: intent.count }],
    }
  }

  if (intent.type === 'SET_LINE_STATUS') {
    const verb = intent.status === 'SUSPENDED' ? '운행을 중단' : '운행을 재개'
    return {
      ok: true,
      summary: `${line.name} ${verb}합니다.`,
      actions: [{ type: 'SET_LINE_STATUS', lineId: line.id, status: intent.status }],
    }
  }

  if (intent.type === 'SET_VEHICLE_SERVICE' || intent.type === 'REMOVE_VEHICLE') {
    const vehicle = line.vehicles[intent.vehicleNumber - 1]
    if (!vehicle) return unresolvedVehicle(line, intent.vehicleNumber)
    if (intent.type === 'REMOVE_VEHICLE') {
      if (!hasExplicitRemovalVerb(rawInput)) return explicitRemovalRequired('차량')
      return {
        ok: true,
        summary: `${line.name} ${intent.vehicleNumber}번 차량을 제거합니다.`,
        actions: [{ type: 'REMOVE_VEHICLE', lineId: line.id, vehicleId: vehicle.id }],
      }
    }
    const verb = intent.inService ? '운행에 투입' : '차고지에 입고'
    return {
      ok: true,
      summary: `${line.name} ${intent.vehicleNumber}번 차량을 ${verb}합니다.`,
      actions: [{
        type: 'SET_VEHICLE_SERVICE',
        lineId: line.id,
        vehicleId: vehicle.id,
        inService: intent.inService,
      }],
    }
  }

  if (intent.type === 'DETACH_STATION') {
    const station = findStation(context, intent.stationName)
    if (!station) return unresolvedTarget('역', context)
    if (!line.stations.some(item => item.id === station.id)) {
      return commandFailure(`${station.name}은(는) ${line.name}에 포함되어 있지 않습니다.`, buildSuggestion(context))
    }
    return {
      ok: true,
      summary: `${station.name}을 ${line.name}에서 제외합니다.`,
      actions: [{ type: 'DETACH_STATION', lineId: line.id, stationId: station.id }],
    }
  }

  if (intent.type === 'INSERT_STATION_BETWEEN') {
    const from = findStation(context, intent.fromStationName)
    const to = findStation(context, intent.toStationName)
    const station = findStation(context, intent.stationName)
    if (!from || !to || !station) return unresolvedTarget('역', context)
    if (line.stations.some(item => item.id === station.id)) {
      return commandFailure(`${station.name}은(는) 이미 ${line.name}에 포함되어 있습니다.`, `${line.name}에 없는 역을 지정해주세요.`)
    }
    const fromIndex = line.stations.findIndex(item => item.id === from.id)
    const toIndex = line.stations.findIndex(item => item.id === to.id)
    if (fromIndex < 0 || toIndex < 0 || Math.abs(fromIndex - toIndex) !== 1) {
      return commandFailure(`${from.name}과 ${to.name}은(는) ${line.name}의 이웃한 두 역이 아닙니다.`, '현재 노선에서 서로 붙어 있는 두 역을 지정해주세요.')
    }
    return {
      ok: true,
      summary: `${line.name}의 ${from.name}–${to.name} 사이에 ${station.name}을 추가합니다.`,
      actions: [{
        type: 'INSERT_STATION',
        lineId: line.id,
        fromStationId: from.id,
        toStationId: to.id,
        stationId: station.id,
      }],
    }
  }

  const target = findStation(context, intent.stationName)
  if (!target) return unresolvedTarget('역', context)
  if (line.stations.some(station => station.id === target.id)) {
    return commandFailure(
      `${target.name}은(는) 이미 ${line.name}에 포함되어 있습니다.`,
      `${line.name}에 아직 연결되지 않은 역을 지정해주세요.`,
    )
  }
  if (line.stations.length === 0) {
    return commandFailure(
      `${line.name}에는 연장할 수 있는 기존 종점이 없습니다.`,
      '지도에서 먼저 두 역을 연결하거나, 두 역 사이에 새 노선을 건설해달라고 입력해주세요.',
    )
  }

  const first = line.stations[0]
  const last = line.stations[line.stations.length - 1]
  const terminus = distance(first, target) <= distance(last, target) ? first : last
  return {
    ok: true,
    summary: `${line.name}을 ${terminus.name} 종점에서 ${target.name} 방향으로 연장합니다.`,
    actions: [{
      type: 'BUILD_SEGMENT',
      lineId: line.id,
      fromStationId: terminus.id,
      toStationId: target.id,
    }],
  }
}

function inferFallbackIntent(rawInput: string, context: CityCommandContext): CommandIntent | null {
  const normalized = normalize(rawInput)
  const mentionedStations = findMentionedStations(rawInput, context)
  const mentionedLines = findMentionedLines(rawInput, context)
  const mentionedLine = mentionedLines[0]
  const vehicleNumber = findMentionedVehicleNumber(rawInput)

  const isNewLine = ['새노선', '새로운노선', '신규노선', '노선건설', '노선을건설', '노선을만들', '노선만들']
    .some(keyword => normalized.includes(keyword))
  if (isNewLine) {
    const mode = normalized.includes('버스') ? 'BUS' : 'SUBWAY'
    if (mentionedStations.length >= 2) {
      return {
        type: 'CREATE_LINE_BETWEEN_STATIONS',
        mode,
        fromStationName: mentionedStations[0].name,
        toStationName: mentionedStations[1].name,
      }
    }
    return { type: 'CREATE_EMPTY_LINE', mode }
  }

  // "새 역"은 새 노선 판정 뒤에 본다 — 두 표현이 한 문장에 있으면 노선 건설이 우선이다.
  const isNewStation = ['새역', '신설역', '역신설', '역건설', '역을건설', '역만들', '역을만들', '역지어', '역을지어']
    .some(keyword => normalized.includes(keyword))
  if (isNewStation && mentionedStations.length === 2 && ['사이', '중간'].some(keyword => normalized.includes(keyword))) {
    return {
      type: 'BUILD_STATION_BETWEEN',
      fromStationName: mentionedStations[0].name,
      toStationName: mentionedStations[1].name,
      newStationName: null,
    }
  }

  const renamedStation = mentionedStations[0]
  const newStationName = extractRenamedStationName(rawInput)
  if (renamedStation && newStationName && ['이름변경', '이름을변경', '이름바꿔', '이름을바꿔', '개명', '로변경', '로바꿔']
    .some(keyword => normalized.includes(keyword))) {
    return {
      type: 'RENAME_STATION',
      stationName: renamedStation.name,
      newStationName,
    }
  }

  // "차량 2대 구입"처럼 대수가 중간에 끼므로 차량 단어와 구매 동사를 따로 확인한다.
  const mentionsVehicleWord = ['차량', '열차'].some(keyword => normalized.includes(keyword))
  const mentionsPurchase = ['구매', '구입', '증차', '사줘', '사주', '뽑아'].some(keyword => normalized.includes(keyword))
  const mentionsVehicleAdd = ['차량추가', '차량을추가', '열차추가'].some(keyword => normalized.includes(keyword))
  if (mentionedLine && ((mentionsVehicleWord && mentionsPurchase) || mentionsVehicleAdd)) {
    return { type: 'BUY_VEHICLE', lineName: mentionedLine.name, count: findMentionedVehicleCount(rawInput) }
  }

  const mentionsEveryVehicle = ['모든차량', '전차량', '차량전부', '차량모두', '모든열차', '열차전부']
    .some(keyword => normalized.includes(keyword))
  if (mentionsEveryVehicle) {
    if (['입고', '차고지로', '운행종료', '전부세워', '모두세워'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_ALL_VEHICLES_SERVICE', lineName: mentionedLine?.name ?? null, inService: false }
    }
    if (['투입', '출고', '운행시작', '운행해', '배차'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_ALL_VEHICLES_SERVICE', lineName: mentionedLine?.name ?? null, inService: true }
    }
  }

  if (['모든노선', '전노선', '노선전부', '노선모두'].some(keyword => normalized.includes(keyword))) {
    if (['운행중단', '운행정지', '폐쇄', '중단해', '멈춰'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_ALL_LINES_STATUS', status: 'SUSPENDED' }
    }
    if (['운행재개', '다시운행', '재개해', '개통해'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_ALL_LINES_STATUS', status: 'OPERATING' }
    }
  }

  if (vehicleNumber && mentionedLine) {
    const vehicleWords = ['차량', '열차', '호차']
    const mentionsVehicle = vehicleWords.some(keyword => normalized.includes(keyword))
    if (mentionsVehicle && mentionedLines.length >= 2 && ['이동', '옮겨', '보내', '전속']
      .some(keyword => normalized.includes(keyword))) {
      return {
        type: 'TRANSFER_VEHICLE',
        lineName: mentionedLine.name,
        vehicleNumber,
        targetLineName: mentionedLines[1].name,
      }
    }
    if (mentionsVehicle && hasExplicitRemovalVerb(rawInput)) {
      return { type: 'REMOVE_VEHICLE', lineName: mentionedLine.name, vehicleNumber }
    }
    if (mentionsVehicle && ['입고', '차고지대기', '차고지로', '운행종료'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_VEHICLE_SERVICE', lineName: mentionedLine.name, vehicleNumber, inService: false }
    }
    if (mentionsVehicle && ['운행시작', '운행해', '투입', '출고', '배차'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_VEHICLE_SERVICE', lineName: mentionedLine.name, vehicleNumber, inService: true }
    }
  }

  if (mentionedLine && hasExplicitRemovalVerb(rawInput) && (
    normalized.includes('노선') || mentionedStations.length === 0
  )) {
    return { type: 'REMOVE_LINE', lineName: mentionedLine.name }
  }

  if (mentionedLine && mentionedStations.length >= 3 && ['사이', '중간'].some(keyword => normalized.includes(keyword)) &&
    ['추가', '삽입', '경유'].some(keyword => normalized.includes(keyword))) {
    const stationsOnLine = mentionedStations.filter(station => mentionedLine.stations.some(item => item.id === station.id))
    const stationToInsert = mentionedStations.find(station => !mentionedLine.stations.some(item => item.id === station.id))
    if (stationsOnLine.length >= 2 && stationToInsert) {
      return {
        type: 'INSERT_STATION_BETWEEN',
        lineName: mentionedLine.name,
        fromStationName: stationsOnLine[0].name,
        toStationName: stationsOnLine[1].name,
        stationName: stationToInsert.name,
      }
    }
  }

  if (mentionedLine && mentionedStations.length >= 1 && (
    normalized.includes('노선에서') || normalized.includes(`${normalize(mentionedLine.name)}에서`)
  ) && ['빼', '제외', '분리', '제거'].some(keyword => normalized.includes(keyword))) {
    return {
      type: 'DETACH_STATION',
      lineName: mentionedLine.name,
      stationName: mentionedStations[0].name,
    }
  }

  if (mentionedStations.length >= 1 && hasExplicitRemovalVerb(rawInput)) {
    return { type: 'REMOVE_STATION', stationName: mentionedStations[0].name }
  }

  if (mentionedLine) {
    if (['운행중단', '운행정지', '폐쇄', '중단해', '멈춰'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_LINE_STATUS', lineName: mentionedLine.name, status: 'SUSPENDED' }
    }
    if (['운행재개', '다시운행', '재개해', '개통해'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_LINE_STATUS', lineName: mentionedLine.name, status: 'OPERATING' }
    }
  }

  if (mentionedLine && mentionedStations.length >= 1 && ['연장', '노선에추가', '노선으로연결']
    .some(keyword => normalized.includes(keyword))) {
    const target = mentionedStations.find(station => !mentionedLine.stations.some(item => item.id === station.id))
      ?? mentionedStations[0]
    return {
      type: 'EXTEND_LINE_TO_STATION',
      lineName: mentionedLine.name,
      stationName: target.name,
    }
  }

  return null
}

function findMentionedStations(rawInput: string, context: CityCommandContext) {
  return context.stations
    .map(station => ({ station, index: entityMentionIndex(rawInput, station.name, 'station') }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(item => item.station)
}

function findMentionedLines(rawInput: string, context: CityCommandContext) {
  return context.lines
    .map(line => ({ line, index: entityMentionIndex(rawInput, line.name, 'line') }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(item => item.line)
}

function findStation(context: CityCommandContext, input: string) {
  return findNamedEntity(context.stations, input, 'station')
}

function findLine(context: CityCommandContext, input: string) {
  return findNamedEntity(context.lines, input, 'line')
}

function findNamedEntity<T extends { name: string }>(
  entities: T[],
  input: string,
  kind: 'station' | 'line',
): T | null {
  const inputAliases = new Set(entityAliases(input, kind))
  const matches = entities.filter(entity => entityAliases(entity.name, kind).some(alias => inputAliases.has(alias)))
  return matches.length === 1 ? matches[0] : null
}

function entityMentionIndex(rawInput: string, name: string, kind: 'station' | 'line') {
  const haystack = normalize(rawInput)
  const indexes = entityAliases(name, kind)
    .map(alias => haystack.indexOf(alias))
    .filter(index => index >= 0)
  return indexes.length > 0 ? Math.min(...indexes) : -1
}

function entityAliases(name: string, kind: 'station' | 'line') {
  const normalized = normalize(name)
  if (kind === 'station') {
    const base = normalized.endsWith('역') ? normalized.slice(0, -1) : normalized
    return [...new Set([normalized, `${base}역`, ...(base.length > 1 ? [base] : [])])]
  }
  if (normalized.length <= 1) return [`${normalized}노선`, `${normalized}버스`]
  // 버스 노선(A노선·B노선…)은 "A버스"로도 부를 수 있게 한다
  const busAlias = /^[a-z]노선$/.test(normalized) ? [`${normalized[0]}버스`] : []
  return [...new Set([normalized, `${normalized}노선`, ...busAlias])]
}

function findMentionedVehicleNumber(rawInput: string) {
  const patterns = [
    /(?:차량|열차)\s*(\d+)\s*(?:번|호)?/u,
    /(\d+)\s*(?:번|호)?\s*(?:차량|열차|호차)/u,
  ]
  for (const pattern of patterns) {
    const match = rawInput.match(pattern)
    const number = match ? Number(match[1]) : 0
    if (Number.isInteger(number) && number > 0) return number
  }

  const normalized = normalize(rawInput)
  const ordinals = [
    ['첫번째', 1],
    ['두번째', 2],
    ['세번째', 3],
    ['네번째', 4],
    ['다섯번째', 5],
  ] as const
  return ordinals.find(([word]) => normalized.includes(`${word}차량`) || normalized.includes(`${word}열차`))?.[1] ?? null
}

function findMentionedVehicleCount(rawInput: string) {
  const match = rawInput.match(/(\d+)\s*대/u)
  const count = match ? Number(match[1]) : 0
  if (Number.isInteger(count) && count > 0) return Math.min(3, count)

  const normalized = normalize(rawInput)
  const words = [['한대', 1], ['두대', 2], ['세대', 3]] as const
  return words.find(([word]) => normalized.includes(word))?.[1] ?? 1
}

// 지도 클릭으로 짓는 역과 같은 기본 이름 규칙 — 삭제로 생긴 번호 구멍을 피해 붙인다.
function nextNewStationName(context: CityCommandContext) {
  const used = new Set(context.stations.map(station => station.name))
  let number = context.stations.length + 1
  while (used.has(`신설역 ${number}`)) number += 1
  return `신설역 ${number}`
}

// 서버 액션 스키마와 같은 지도 범위 (posX 4~96, posY 4~92)
function clampMapX(value: number) {
  return Math.round(Math.max(4, Math.min(96, value)) * 10) / 10
}

function clampMapY(value: number) {
  return Math.round(Math.max(4, Math.min(92, value)) * 10) / 10
}

function extractRenamedStationName(rawInput: string) {
  const match = rawInput.match(/([가-힣A-Za-z0-9]{1,12}?)\s*(?:으로|로)\s*(?:이름을?\s*)?(?:변경|바꿔|바꾸|개명)/u)
  return match?.[1]?.trim() ?? null
}

function hasExplicitRemovalVerb(rawInput: string) {
  const normalized = normalize(rawInput)
  return ['삭제', '제거', '철거', '없애', '폐기'].some(keyword => normalized.includes(keyword))
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s"'`.,!?…·\-_/()[\]{}:]/g, '')
}

function distance(a: CityCommandStation, b: CityCommandStation) {
  return Math.hypot(a.posX - b.posX, a.posY - b.posY)
}

function unresolvedTarget(kind: '역' | '노선', context: CityCommandContext): CityCommandPlanResult {
  return commandFailure(`명령에 나온 ${kind}을(를) 현재 도시에서 찾지 못했습니다.`, buildSuggestion(context))
}

function unresolvedVehicle(line: CityCommandLine, vehicleNumber: number): CityCommandPlanResult {
  const suggestion = line.vehicles.length > 0
    ? `${line.name} 차량 번호는 1번부터 ${line.vehicles.length}번까지입니다.`
    : `${line.name}에는 관리할 차량이 없습니다.`
  return commandFailure(`${line.name}의 ${vehicleNumber}번 차량을 찾지 못했습니다.`, suggestion)
}

function explicitRemovalRequired(target: '노선' | '역' | '차량'): CityCommandPlanResult {
  return commandFailure(
    `${target} 삭제는 삭제·제거·철거처럼 의도가 분명한 표현이 필요합니다.`,
    `삭제할 ${target} 이름이나 번호와 “삭제해줘”를 함께 입력해주세요.`,
  )
}

function commandFailure(reason: string, suggestion: string): CityCommandPlanResult {
  return { ok: false, reason, suggestion }
}

function buildSuggestion(context: CityCommandContext) {
  const line = context.lines[0]
  if (line) return `예: “${line.name} 운행을 중단해줘.” 또는 “${line.name} 노선을 삭제해줘.”`
  const [first, second] = context.stations
  if (first && second) return `예: “${first.name}과 ${second.name} 사이에 새로운 노선을 건설해 줘.”`
  return '역을 두 개 이상 만든 뒤 새 노선 건설을 요청하거나, 현재 노선과 역의 정확한 이름을 사용해주세요.'
}
