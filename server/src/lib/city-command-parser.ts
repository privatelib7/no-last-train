import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'

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
  | { type: 'SET_VEHICLE_SERVICE'; lineId: string; vehicleId: string; inService: boolean }
  | { type: 'TRANSFER_VEHICLE'; lineId: string; vehicleId: string; targetLineId: string }
  | { type: 'REMOVE_VEHICLE'; lineId: string; vehicleId: string }

export type CityCommandPlanResult =
  | { ok: true; summary: string; actions: CityCommandAction[] }
  | { ok: false; reason: string; suggestion: string }

const CommandIntentSchema = z.discriminatedUnion('type', [
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
  command: CommandIntentSchema,
})

type CommandIntent = Exclude<z.infer<typeof CommandIntentSchema>, { type: 'UNSUPPORTED' }>

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-nano'
const client = apiKey && !apiKey.includes('...')
  ? new OpenAI({ apiKey, timeout: 8_000, maxRetries: 0 })
  : null

const SYSTEM_PROMPT = `
당신은 도시 교통 운영 게임의 명령 해석기입니다.
사용자의 한국어 명령을 아래 command 객체 중 정확히 하나로 변환하세요.

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

규칙:
- 제공된 역과 노선 이름만 그대로 사용하세요. ID, 좌표, 공사비는 만들지 마세요.
- 차량 번호는 각 노선에 표시된 1부터 시작하는 번호입니다.
- 사용자가 버스를 명시하지 않은 새 노선은 SUBWAY입니다.
- 삭제, 제거, 철거, 폐기처럼 파괴적인 동사를 명시하지 않았다면 REMOVE_*로 분류하지 마세요.
- "노선에서 역을 빼기"와 "도시에서 역을 완전히 삭제하기"를 구분하세요.
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
      const intent = await parseWithAi(rawInput, context)
      if (intent) {
        const resolved = resolveCityCommandIntent(intent, context, rawInput)
        if (resolved.ok) return resolved
        aiFailure = resolved
      }
    } catch {
      // 모델 호출이 실패해도 명시적인 핵심 명령은 로컬 해석기로 계속 동작한다.
    }
  }

  if (fallbackIntent) return resolveCityCommandIntent(fallbackIntent, context, rawInput)
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
  return resolveCityCommandIntent(intent, context, rawInput)
}

async function parseWithAi(rawInput: string, context: CityCommandContext): Promise<CommandIntent | null> {
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
    max_output_tokens: 300,
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
  const parsed = response.output_parsed?.command
  return parsed && parsed.type !== 'UNSUPPORTED' ? parsed : null
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
  return [...new Set([normalized, `${normalized}노선`])]
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
