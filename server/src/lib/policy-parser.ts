import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import type { PolicyParseResult, ParsedPolicy } from '@/types/game'

const PolicyResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    policy: z.object({
      type: z.enum(['CONGESTION_RESPONSE', 'PASSENGER_PRIORITY', 'SUPPORT_CONDITION']),
      conditionStationId: z.string().nullable(),
      conditionThreshold: z.number().min(0).max(100).nullable(),
      conditionTimeStart: z.number().min(0).max(23).nullable(),
      conditionTimeEnd: z.number().min(0).max(23).nullable(),
      actionType: z.enum(['DEPLOY_SPARE', 'ADJUST_HEADWAY', 'LEND_VEHICLE']),
      actionTargetLineId: z.string().nullable(),
      resourceLimit: z.number().int().positive(),
      parsedSummary: z.string().min(1),
    }),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
    suggestion: z.string().min(1),
  }),
])

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-nano'
const client = apiKey && !apiKey.includes('...')
  ? new OpenAI({ apiKey, timeout: 8_000, maxRetries: 0 })
  : null

const SYSTEM_PROMPT = `
당신은 지하철 운영 게임의 AI 노선 관리자입니다.
플레이어의 자연어 운영 지침을 아래 JSON 스키마로만 변환합니다.

지원하는 정책 유형 3가지:
1. CONGESTION_RESPONSE - 혼잡 대응 (예: "중앙역이 70% 넘으면 예비 차량 투입")
2. PASSENGER_PRIORITY - 승객 우선순위 (예: "출근 시간엔 환승 승객 우선")
3. SUPPORT_CONDITION - 지원 조건 (예: "혼잡도 60% 미만이면 파랑 노선에 차량 빌려줘")

지원하는 행동 3가지:
- DEPLOY_SPARE: 예비 차량 투입
- ADJUST_HEADWAY: 배차 간격 조정
- LEND_VEHICLE: 다른 노선에 차량 대여

응답은 반드시 아래 두 형식 중 하나입니다. 적용되지 않는 선택 필드는 null로 채우세요:

성공:
{"ok": true, "policy": {"type": "...", "conditionStationId": null, "conditionThreshold": 70, "conditionTimeStart": null, "conditionTimeEnd": null, "actionType": "DEPLOY_SPARE", "actionTargetLineId": null, "resourceLimit": 1, "parsedSummary": "..."}}

실패 (스키마 밖 요청):
{"ok": false, "reason": "...", "suggestion": "..."}

conditionThreshold는 퍼센트 숫자(0-100).
parsedSummary는 한국어 1문장 요약.
`.trim()

export async function parsePolicy(
  rawInput: string,
  context: { stationNames: string[]; lineColors: string[] },
): Promise<PolicyParseResult> {
  const userMessage = `
역 목록: ${context.stationNames.join(', ')}
노선: ${context.lineColors.join(', ')}

플레이어 지침: "${rawInput}"
`.trim()

  try {
    if (!client) return buildFallback(rawInput)

    const response = await client.responses.parse({
      model,
      max_output_tokens: 512,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      text: {
        format: zodTextFormat(PolicyResponseSchema, 'policy_parse_result'),
      },
    })

    const result = response.output_parsed
    if (!result) {
      return {
        ok: false,
        reason: 'AI 응답을 파싱할 수 없습니다.',
        suggestion: '좀 더 구체적으로 입력해주세요. 예: "중앙역 혼잡도 70% 넘으면 예비 차량 투입"',
      }
    }

    if (result.ok === false) return result

    // 기본값 보정
    const policy: ParsedPolicy = {
      type: result.policy.type,
      conditionStationId: result.policy.conditionStationId ?? undefined,
      conditionThreshold: result.policy.conditionThreshold ?? undefined,
      conditionTimeStart: result.policy.conditionTimeStart ?? undefined,
      conditionTimeEnd: result.policy.conditionTimeEnd ?? undefined,
      actionType: result.policy.actionType,
      actionTargetLineId: result.policy.actionTargetLineId ?? undefined,
      resourceLimit: result.policy.resourceLimit,
      parsedSummary: result.policy.parsedSummary,
    }
    return { ok: true, policy }

  } catch (err) {
    // AI 호출 실패 → 템플릿 폴백
    return buildFallback(rawInput)
  }
}

// ─── 폴백: AI 없이 키워드 기반 파싱 ─────────────────────────────────────

function buildFallback(rawInput: string): PolicyParseResult {
  const lower = rawInput.toLowerCase()

  // 혼잡도 숫자 추출
  const thresholdMatch = rawInput.match(/(\d+)\s*%/)
  const threshold = thresholdMatch ? parseInt(thresholdMatch[1]) : 70

  if (lower.includes('빌려') || lower.includes('지원') || lower.includes('대여')) {
    return {
      ok: true,
      policy: {
        type: 'SUPPORT_CONDITION',
        conditionThreshold: threshold,
        actionType: 'LEND_VEHICLE',
        resourceLimit: 1,
        parsedSummary: `내 노선 혼잡도 ${threshold}% 미만일 때 다른 노선에 차량 1대 대여`,
      },
    }
  }

  if (lower.includes('예비') || lower.includes('투입')) {
    return {
      ok: true,
      policy: {
        type: 'CONGESTION_RESPONSE',
        conditionThreshold: threshold,
        actionType: 'DEPLOY_SPARE',
        resourceLimit: 1,
        parsedSummary: `혼잡도 ${threshold}% 초과 시 예비 차량 1대 투입`,
      },
    }
  }

  if (lower.includes('배차') || lower.includes('간격')) {
    return {
      ok: true,
      policy: {
        type: 'CONGESTION_RESPONSE',
        conditionThreshold: threshold,
        actionType: 'ADJUST_HEADWAY',
        resourceLimit: 1,
        parsedSummary: `혼잡도 ${threshold}% 초과 시 배차 간격 단축`,
      },
    }
  }

  if (lower.includes('우선') || lower.includes('먼저')) {
    return {
      ok: true,
      policy: {
        type: 'PASSENGER_PRIORITY',
        conditionTimeStart: 7,
        conditionTimeEnd: 10,
        actionType: 'ADJUST_HEADWAY',
        resourceLimit: 1,
        parsedSummary: '출근 시간에 환승 승객을 우선 수송하고 배차 간격을 단축',
      },
    }
  }

  return {
    ok: false,
    reason: '지원하는 정책 유형을 인식하지 못했습니다.',
    suggestion: '다음 중 하나로 입력해주세요:\n· "역명 혼잡도 N% 넘으면 예비 차량 투입"\n· "혼잡도 N% 미만이면 파랑 노선에 차량 빌려줘"\n· "배차 간격 단축"',
  }
}
