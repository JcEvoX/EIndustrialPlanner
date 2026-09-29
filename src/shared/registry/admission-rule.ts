import { ADMISSION_RATE_WINDOWS_PER_MINUTE } from "@/domain/registry";
import type { EntityAdmissionRuleDefinition } from "@/domain/registry/types/entity-definition";

/**
 * 将准入口速率上限（件/分钟）向上取整到 ADMISSION_RATE_WINDOWS_PER_MINUTE 的正整数倍。
 *
 * 运行时把 perMinuteLimit 均分到 ADMISSION_RATE_WINDOWS_PER_MINUTE 个 10 秒窗口，每窗额度取
 * `Math.floor(perMinuteLimit / 窗口数)`（见 simulation/dense/dense-simulation-kernel.ts 与
 * simulation/legacy/runtime-state.ts）。因此 rate < 窗口数、或不是窗口数整数倍时会被下取整到
 * 0 或更低的等效速率（如 5/6→0、7/6→1 即 6/min）。注册表约定 perMinuteLimit 必须是窗口数的正整数倍，
 * 本函数统一承担该归一化：只可能放宽限速、不会收紧。
 *
 * AI-CORRECTION 2026-09-29: 规划器原本在「运行消耗端口」限速处内联该取整，而 expandSplitTree 的
 * 分支限速直接写入原始 rate，导致 rate<6 的支路每窗额度被下取整为 0，消费端被永久饿死。
 * 三处（两层限速、供料审计）必须共享同一份取整语义，故上提到本 shared 单一真源。
 */
export function normalizeAdmissionRateLimit(rate: number): number {
  return Math.ceil(rate / ADMISSION_RATE_WINDOWS_PER_MINUTE - 1e-6) * ADMISSION_RATE_WINDOWS_PER_MINUTE;
}

/**
 * 解析实体 config 或端口声明中的准入口规则。
 *
 * AI-CORRECTION 2026-09-23: 原实现是 src/app/shell/inspector/admission-rule-inspector.tsx 的私有函数。
 * 基地问题检查与 Inspector 需要同一份 perMinuteLimit 解析语义，故上提为 shared 单一真源。
 */
export function readAdmissionRule(value: unknown): EntityAdmissionRuleDefinition | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const itemId = typeof record.itemId === "string" && record.itemId.length > 0
    ? record.itemId
    : null;
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit)
    ? Math.max(0, Math.floor(record.limit))
    : null;
  const perMinuteLimit = typeof record.perMinuteLimit === "number" && Number.isFinite(record.perMinuteLimit)
    ? Math.max(0, Math.floor(record.perMinuteLimit))
    : null;

  return { itemId, limit, perMinuteLimit };
}
