import Anthropic from '@anthropic-ai/sdk'
import type { PolicyParseResult, ParsedPolicy } from '@/types/game'

const apiKey = process.env.ANTHROPIC_API_KEY
const client = apiKey && !apiKey.includes('...') ? new Anthropic({ apiKey }) : null

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

응답은 반드시 아래 두 형식 중 하나입니다:

성공:
{"ok": true, "policy": {"type": "...", "conditionThreshold": 70, "actionType": "DEPLOY_SPARE", "resourceLimit": 1, "parsedSummary": "..."}}

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

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        ok: false,
        reason: 'AI 응답을 파싱할 수 없습니다.',
        suggestion: '좀 더 구체적으로 입력해주세요. 예: "중앙역 혼잡도 70% 넘으면 예비 차량 투입"',
      }
    }

    const result = JSON.parse(jsonMatch[0])
    if (result.ok === false) return result as PolicyParseResult

    // 기본값 보정
    const policy: ParsedPolicy = {
      type: result.policy.type,
      conditionStationId: result.policy.conditionStationId,
      conditionThreshold: result.policy.conditionThreshold,
      conditionTimeStart: result.policy.conditionTimeStart,
      conditionTimeEnd: result.policy.conditionTimeEnd,
      actionType: result.policy.actionType,
      actionTargetLineId: result.policy.actionTargetLineId,
      resourceLimit: result.policy.resourceLimit ?? 1,
      parsedSummary: result.policy.parsedSummary ?? rawInput,
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
