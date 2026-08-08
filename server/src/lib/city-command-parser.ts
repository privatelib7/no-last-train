import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

export type CityCommandStation = {
  id: string
  name: string
  posX: number
  posY: number
}

export type CityCommandLine = {
  id: string
  name: string
  mode: 'SUBWAY' | 'BUS'
  status: 'OPERATING' | 'DEGRADED' | 'SUSPENDED'
  stations: CityCommandStation[]
}

export type CityCommandContext = {
  stations: CityCommandStation[]
  lines: CityCommandLine[]
}

export type CityCommandAction =
  | {
      type: 'CREATE_CONNECTED_LINE'
      mode: 'SUBWAY' | 'BUS'
      fromStationId: string
      toStationId: string
    }
  | {
      type: 'BUILD_SEGMENT'
      lineId: string
      fromStationId: string
      toStationId: string
    }
  | {
      type: 'SET_LINE_STATUS'
      lineId: string
      status: 'OPERATING' | 'SUSPENDED'
    }

export type CityCommandPlanResult =
  | { ok: true; summary: string; actions: CityCommandAction[] }
  | { ok: false; reason: string; suggestion: string }

const CommandIntentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CREATE_LINE_BETWEEN_STATIONS'),
    mode: z.enum(['SUBWAY', 'BUS']).default('SUBWAY'),
    fromStationName: z.string().min(1),
    toStationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('EXTEND_LINE_TO_STATION'),
    lineName: z.string().min(1),
    stationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('SET_LINE_STATUS'),
    lineName: z.string().min(1),
    status: z.enum(['OPERATING', 'SUSPENDED']),
  }),
])

type CommandIntent = z.infer<typeof CommandIntentSchema>

const apiKey = process.env.ANTHROPIC_API_KEY
const client = apiKey && !apiKey.includes('...') ? new Anthropic({ apiKey }) : null

const SYSTEM_PROMPT = `
당신은 도시 교통 운영 게임의 명령 해석기입니다.
사용자의 한국어 명령을 아래 JSON 객체 중 정확히 하나로 변환하세요.

1. 두 기존 역 사이에 새 노선 건설
{"type":"CREATE_LINE_BETWEEN_STATIONS","mode":"SUBWAY|BUS","fromStationName":"실제 역 이름","toStationName":"실제 역 이름"}

2. 기존 노선을 기존 역 방향으로 연장
{"type":"EXTEND_LINE_TO_STATION","lineName":"실제 노선 이름","stationName":"실제 역 이름"}

3. 기존 노선 운행 중단 또는 재개
{"type":"SET_LINE_STATUS","lineName":"실제 노선 이름","status":"OPERATING|SUSPENDED"}

규칙:
- 제공된 역과 노선 이름만 그대로 사용하세요. ID, 좌표, 공사비는 만들지 마세요.
- 사용자가 버스를 명시하지 않은 새 노선은 SUBWAY입니다.
- 설명이나 마크다운 없이 JSON 객체만 출력하세요.
- 지원하지 않거나 대상이 불명확한 명령은 {"unsupported":true}를 출력하세요.
`.trim()

export async function parseCityCommand(
  rawInput: string,
  context: CityCommandContext,
): Promise<CityCommandPlanResult> {
  const fallbackIntent = inferFallbackIntent(rawInput, context)

  if (client) {
    try {
      const intent = await parseWithAi(rawInput, context)
      if (intent) {
        const resolved = resolveCityCommandIntent(intent, context)
        if (resolved.ok) return resolved
      }
    } catch {
      // 모델 호출이 실패해도 게임의 핵심 예시는 로컬 해석기로 계속 동작한다.
    }
  }

  if (fallbackIntent) return resolveCityCommandIntent(fallbackIntent, context)

  return {
    ok: false,
    reason: '명령에서 역 또는 노선을 정확히 찾지 못했습니다.',
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
  return resolveCityCommandIntent(intent, context)
}

async function parseWithAi(rawInput: string, context: CityCommandContext): Promise<CommandIntent | null> {
  if (!client) return null

  const stationList = context.stations.map(station => station.name).join(', ')
  const lineList = context.lines.map(line => {
    const endpoints = line.stations.length > 0
      ? `${line.stations[0].name}–${line.stations[line.stations.length - 1].name}`
      : '연결 역 없음'
    return `${line.name}(${line.mode}, ${endpoints})`
  }).join(', ')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `역: ${stationList}\n노선: ${lineList}\n명령: ${rawInput}`,
    }],
  }, {
    timeout: 8_000,
    maxRetries: 0,
  })
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  const parsed = JSON.parse(jsonMatch[0])
  if (parsed?.unsupported === true) return null
  const result = CommandIntentSchema.safeParse(parsed)
  return result.success ? result.data : null
}

function resolveCityCommandIntent(
  intent: CommandIntent,
  context: CityCommandContext,
): CityCommandPlanResult {
  if (intent.type === 'CREATE_LINE_BETWEEN_STATIONS') {
    const from = findStation(context, intent.fromStationName)
    const to = findStation(context, intent.toStationName)
    if (!from || !to) {
      return unresolvedTarget('역', context)
    }
    if (from.id === to.id) {
      return {
        ok: false,
        reason: '새 노선을 만들려면 서로 다른 두 역이 필요합니다.',
        suggestion: buildSuggestion(context),
      }
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

  const line = findLine(context, intent.lineName)
  if (!line) return unresolvedTarget('노선', context)

  if (intent.type === 'SET_LINE_STATUS') {
    const verb = intent.status === 'SUSPENDED' ? '운행을 중단' : '운행을 재개'
    return {
      ok: true,
      summary: `${line.name} ${verb}합니다.`,
      actions: [{ type: 'SET_LINE_STATUS', lineId: line.id, status: intent.status }],
    }
  }

  const target = findStation(context, intent.stationName)
  if (!target) return unresolvedTarget('역', context)
  if (line.stations.some(station => station.id === target.id)) {
    return {
      ok: false,
      reason: `${target.name}은(는) 이미 ${line.name}에 포함되어 있습니다.`,
      suggestion: `${line.name}에 아직 연결되지 않은 역을 지정해주세요.`,
    }
  }
  if (line.stations.length === 0) {
    return {
      ok: false,
      reason: `${line.name}에는 연장할 수 있는 기존 종점이 없습니다.`,
      suggestion: '지도에서 먼저 두 역을 연결하거나, 두 역 사이에 새 노선을 건설해달라고 입력해주세요.',
    }
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
  const mentionedLine = findMentionedLine(rawInput, context)

  const isNewLine = ['새노선', '새로운노선', '신규노선', '노선건설', '노선을건설', '노선을만들']
    .some(keyword => normalized.includes(keyword))
  if (isNewLine && mentionedStations.length >= 2) {
    return {
      type: 'CREATE_LINE_BETWEEN_STATIONS',
      mode: normalized.includes('버스') ? 'BUS' : 'SUBWAY',
      fromStationName: mentionedStations[0].name,
      toStationName: mentionedStations[1].name,
    }
  }

  if (normalized.includes('연장') && mentionedLine && mentionedStations.length >= 1) {
    const target = mentionedStations.find(station => !mentionedLine.stations.some(item => item.id === station.id))
      ?? mentionedStations[0]
    return {
      type: 'EXTEND_LINE_TO_STATION',
      lineName: mentionedLine.name,
      stationName: target.name,
    }
  }

  if (mentionedLine) {
    if (['운행중단', '운행정지', '폐쇄', '중단해', '멈춰'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_LINE_STATUS', lineName: mentionedLine.name, status: 'SUSPENDED' }
    }
    if (['운행재개', '다시운행', '재개해', '개통해'].some(keyword => normalized.includes(keyword))) {
      return { type: 'SET_LINE_STATUS', lineName: mentionedLine.name, status: 'OPERATING' }
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

function findMentionedLine(rawInput: string, context: CityCommandContext) {
  return context.lines
    .map(line => ({ line, index: entityMentionIndex(rawInput, line.name, 'line') }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0]?.line ?? null
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

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s"'`.,!?…·\-_/()[\]{}:]/g, '')
}

function distance(a: CityCommandStation, b: CityCommandStation) {
  return Math.hypot(a.posX - b.posX, a.posY - b.posY)
}

function unresolvedTarget(kind: '역' | '노선', context: CityCommandContext): CityCommandPlanResult {
  return {
    ok: false,
    reason: `명령에 나온 ${kind}을(를) 현재 도시에서 찾지 못했습니다.`,
    suggestion: buildSuggestion(context),
  }
}

function buildSuggestion(context: CityCommandContext) {
  const [first, second] = context.stations
  if (first && second) {
    return `예: “${first.name}과 ${second.name} 사이에 새로운 노선을 건설해 줘.”`
  }
  return '역을 두 개 이상 만든 뒤 새 노선 건설이나 기존 노선 연장을 요청해주세요.'
}
