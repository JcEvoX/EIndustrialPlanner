/**
 * 区域产线建模 · 配比求解层（L2）
 *
 * 在「地区范围」给定的前提下，复用生产规划求解器 computeProductionPlan（物料平衡树）产出：
 * 1. 全资源基础计划：该地区每种可换券物品各 1 份基础速率，用来保证探索期不缺料；
 * 2. 单位面积价值排名：逐物品求解单条产线，得到「价值/分钟/格」的边际效率；
 * 3. 最高单位面积价值计划：基础计划之外，用剩余面积按最高边际效率追加高价值产线。
 *
 * 说明：本层把「基地面积」当作真实硬约束；采掘设备（矿机 / 水泵 / 种植机）作为普通设备参与求解，
 * 因此起始作物产能与中间环节产能由求解器自动配平，而不是人工拍机器数量。
 *
 * AI-CORRECTION 2026-09-26: 上述描述已失效，不再使用物料平衡树。
 * 原因：物料平衡树无法表达多配方环（如 crystal_shell ↔ crystal_powder、植物自增环），会把环内物品静默标成缺口。
 * 新行为：L2 改为自研线性规划内核（./lp/simplex.ts + ./lp/region-lp.ts），同时表达「区域自然资源上限」与「基地面积预算」双重约束，
 * 目标函数为「价值/分钟最大」，基线为「每种可生产券物品 ≥ targetPerMinute」。
 */

import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { BaseDefinition } from "@/domain/registry/types/base-definition";
import {
  buildProductionPlanningIndex,
  computeItemDefaultPerMinute,
  type ProductionPlanningIndex,
  type ProductionPlanningSourceConfig,
} from "@/app/shell/production-planning/production-planning-model";
import {
  computePlanMetrics,
  lookupRegistryText,
  type MachineUsage,
  type ProductionPlanMetrics,
} from "./plan-metrics";
import {
  buildRegionLpVariables,
  resolveInfiniteSupplyItemIds,
  solveRegionLp,
  toProductionPlanningResult,
  type RegionLpOptions,
  type RegionLpVariable,
} from "./lp/region-lp";
import {
  createRegionScopedRegistry,
  resolveRegionValuableItems,
  type RegionValuableItem,
} from "./region-scope";

/** 与面板默认一致：副产物回收利用、污水外供、净水器关闭、设备最低消耗按小数计。 */
export const DEFAULT_SOURCE_CONFIG: ProductionPlanningSourceConfig = {
  waterPolicy: "use-byproduct",
  acidPolicy: "use-byproduct",
  sewagePolicy: "external-supply",
  waterPurifierPolicy: "disabled",
  includeDeviceMinimumConsumption: "fractional",
};

/** 未登记专用 tag，只能按物品 id 判定「可排放副产物」。 */
const SEWAGE_ITEM_ID = "item_liquid_sewage";
const WATER_ITEM_ID = "item_liquid_water";
const ACID_ITEM_ID = "item_liquid_acid";

export interface RegionProductionOptions {
  /** 全资源基础计划中，每种物品的目标速率（每分钟）。 */
  readonly targetPerMinute: number;
  /** 可占用面积预算（格）；缺省为基地可摆放面积。 */
  readonly areaBudget: number;
  /** 区域自然资源开采上限（每分钟）；缺省表示不设上限。 */
  readonly resourceLimits: ReadonlyMap<string, number>;
  readonly sourceConfig: ProductionPlanningSourceConfig;
}

export function createDefaultRegionProductionOptions(
  base: BaseDefinition,
  overrides: Partial<RegionProductionOptions> = {},
): RegionProductionOptions {
  return {
    targetPerMinute: overrides.targetPerMinute ?? 1,
    areaBudget: overrides.areaBudget ?? base.placeableArea.width * base.placeableArea.height,
    resourceLimits: overrides.resourceLimits ?? new Map<string, number>(),
    sourceConfig: overrides.sourceConfig ?? { ...DEFAULT_SOURCE_CONFIG },
  };
}

export interface RegionPlan {
  readonly result: ReturnType<typeof toProductionPlanningResult>;
  readonly metrics: ProductionPlanMetrics;
}

export interface ValueEfficiencyEntry {
  readonly itemId: string;
  readonly name: string;
  readonly value: number;
  /** 单条产线的参考速率：单机满速产出。 */
  readonly perMinute: number;
  readonly deviceArea: number;
  /** 每 (1/分钟) 产出所需的设备占地（格），用于边际成本估算。 */
  readonly areaPerUnitPerMinute: number;
  readonly deviceCount: number;
  readonly powerDemandPerTick: number;
  readonly valuePerMinute: number;
  /** 价值 / 分钟 / 格。 */
  readonly valuePerArea: number;
  readonly machineUsages: MachineUsage[];
}

export interface RegionMaxValuePlan extends RegionPlan {
  readonly budget: number;
  readonly baselineArea: number;
  readonly remainingArea: number;
  readonly areaUtilization: number;
  readonly overflow: {
    readonly itemId: string;
    readonly name: string;
    readonly value: number;
    readonly perMinute: number;
    readonly valuePerMinute: number;
  } | null;
}

export interface RegionAnalysis {
  readonly base: BaseDefinition;
  readonly options: RegionProductionOptions;
  readonly valuable: RegionValuableItem[];
  readonly producible: RegionValuableItem[];
  readonly gaps: RegionValuableItem[];
  readonly allResource: RegionPlan;
  readonly valueRanking: ValueEfficiencyEntry[];
  readonly maxValue: RegionMaxValuePlan;
}

const EPSILON = 0.0001;

/** 构造地区范围内的生产规划索引（排除活动限定内容）。 */
export function createRegionProductionIndex(
  registry: RegistryContract,
  base: BaseDefinition,
): ProductionPlanningIndex {
  return buildProductionPlanningIndex(createRegionScopedRegistry(registry, base), {
    includeInactiveActivityContent: false,
    activeActivityIds: [],
  });
}

/** 区分「该地区可自动生产」与「该地区不可生产（配方/机器缺失）」的券价值物品。 */
export function resolveProducibleValuableItems(
  index: ProductionPlanningIndex,
  valuable: readonly RegionValuableItem[],
): { producible: RegionValuableItem[]; gaps: RegionValuableItem[] } {
  const producible: RegionValuableItem[] = [];
  const gaps: RegionValuableItem[] = [];
  for (const item of valuable) {
    const candidates = index.candidatesByOutputItem.get(item.itemId) ?? [];
    if (candidates.some((candidate) => candidate.sourceType === "system-recipe")) {
      producible.push(item);
    } else {
      gaps.push(item);
    }
  }
  return { producible, gaps };
}

// AI-REMOVED 2026-09-26:
// Reason: 物料平衡树求解器无法表达多配方环，会把环内物品静默标成「缺口」，导致 EDA 报「原规划缺少物料来源」。
// Trigger: EDA 校验 blueprint 时抛出 PlannerCandidateError：原规划缺少物料来源：item_crystal_shell，1.00/min。
// Evidence: .temp/.trash/eda-probe/diag-cycle.mjs 与 diag-choices.mjs 复现 crystal_shell ↔ crystal_powder 环。
// Replacement: ./lp/region-lp.ts 的 solveRegionLp（两阶段单纯形）+ 本文件 solvePlan。
// Risk: Low
// Human Review: Required
//
// Original code:
// function solve(
//   index: ProductionPlanningIndex,
//   targetRates: ReadonlyMap<string, number>,
//   valueByItemId: ReadonlyMap<string, number>,
//   sourceConfig: ProductionPlanningSourceConfig,
// ): RegionPlan {
//   const targets: ProductionPlanningPort[] = [];
//   for (const [itemId, perMinute] of targetRates) {
//     if (perMinute > EPSILON) {
//       targets.push({ id: `target:${itemId}`, itemId, perMinute });
//     }
//   }
//   const result = computeProductionPlan(
//     {
//       targets,
//       supplies: [],
//       infiniteItemIds: new Set<string>(),
//       recipeChoices: new Map<string, string>(),
//       sourceConfig,
//     },
//     index,
//   );
//   const shipped = targets.map((target) => ({
//     itemId: target.itemId,
//     perMinute: target.perMinute,
//     value: valueByItemId.get(target.itemId) ?? 0,
//   }));
//   return { result, metrics: computePlanMetrics({ result, index, shipped }) };
// }

/** 组装与目标无关的 LP 选项（面积、价值、资源上限、无限供应与可排放物）。 */
function buildSharedLpOptions(
  index: ProductionPlanningIndex,
  options: RegionProductionOptions,
  valueByItemId: ReadonlyMap<string, number>,
): Omit<RegionLpOptions, "targets" | "objective"> {
  const dumpableItemIds = new Set<string>();
  if (options.sourceConfig.sewagePolicy === "external-supply") {
    dumpableItemIds.add(SEWAGE_ITEM_ID);
  }
  if (options.sourceConfig.waterPolicy === "dump-byproduct") {
    dumpableItemIds.add(WATER_ITEM_ID);
  }
  if (options.sourceConfig.acidPolicy === "dump-byproduct") {
    dumpableItemIds.add(ACID_ITEM_ID);
  }
  return {
    areaBudget: options.areaBudget,
    valueByItemId,
    resourceLimits: options.resourceLimits,
    infiniteItemIds: resolveInfiniteSupplyItemIds(index),
    dumpableItemIds,
  };
}

/** 求解一次区域线性规划并折算为 RegionPlan；基线不可行时退回无基线求解。 */
function solvePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: RegionLpOptions,
): RegionPlan {
  let attempt = solveRegionLp(index, lpOptions, variables);
  if (attempt.solution.status !== "optimal" && lpOptions.targets.size > 0) {
    attempt = solveRegionLp(index, { ...lpOptions, targets: new Map() }, variables);
  }
  if (attempt.solution.status !== "optimal") {
    throw new Error(`区域线性规划未取得最优解：${attempt.solution.status}`);
  }
  const result = toProductionPlanningResult(attempt.build, attempt.deviceCounts);
  return {
    result,
    metrics: computePlanMetrics({ result, index, shipped: resolveShipped(attempt, lpOptions.valueByItemId) }),
  };
}

/** LP 解的券价值外送：净产出为正且登记了价值的物品。 */
function resolveShipped(
  attempt: ReturnType<typeof solveRegionLp>,
  valueByItemId: ReadonlyMap<string, number>,
): { itemId: string; perMinute: number; value: number }[] {
  const shipped: { itemId: string; perMinute: number; value: number }[] = [];
  for (const total of toProductionPlanningResult(attempt.build, attempt.deviceCounts).itemTotals) {
    const net = total.producedPerMinute - total.demandPerMinute;
    const value = valueByItemId.get(total.itemId) ?? 0;
    if (net > EPSILON && value > 0) {
      shipped.push({ itemId: total.itemId, perMinute: net, value });
    }
  }
  return shipped;
}

function toRateMap(items: readonly RegionValuableItem[], perMinute: number): Map<string, number> {
  const rates = new Map<string, number>();
  for (const item of items) {
    rates.set(item.itemId, perMinute);
  }
  return rates;
}

function toValueMap(items: readonly RegionValuableItem[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const item of items) {
    values.set(item.itemId, item.value);
  }
  return values;
}

/** 逐物品求解单条产线，得到单位面积价值效率排名（降序）。 */
export function computeValueEfficiencyRanking(
  index: ProductionPlanningIndex,
  producible: readonly RegionValuableItem[],
  options: RegionProductionOptions,
  variables: readonly RegionLpVariable[],
  shared: Omit<RegionLpOptions, "targets" | "objective">,
): ValueEfficiencyEntry[] {
  const entries: ValueEfficiencyEntry[] = [];
  for (const item of producible) {
    const rate = Math.max(computeItemDefaultPerMinute(item.itemId, index), options.targetPerMinute);
    const plan = solvePlan(index, variables, {
      ...shared,
      targets: new Map([[item.itemId, rate]]),
      objective: "area",
    });
    const deviceArea = plan.metrics.deviceArea;
    const areaPerUnitPerMinute = deviceArea / rate;
    const valuePerMinute = rate * item.value;
    entries.push({
      itemId: item.itemId,
      name: lookupRegistryText(item.nameKey),
      value: item.value,
      perMinute: rate,
      deviceArea,
      areaPerUnitPerMinute,
      deviceCount: plan.metrics.totalDeviceCountCeil,
      powerDemandPerTick: plan.metrics.powerDemandPerTick,
      valuePerMinute,
      valuePerArea: deviceArea > EPSILON ? valuePerMinute / deviceArea : Number.POSITIVE_INFINITY,
      machineUsages: plan.metrics.machineUsages,
    });
  }
  return entries.sort((left, right) => right.valuePerArea - left.valuePerArea);
}

/** 对比基线与最优计划的净产出差，给出「剩余产能追加的高价值产线」。 */
function resolveOverflow(
  baseline: RegionPlan,
  maxValue: RegionPlan,
  valueByItemId: ReadonlyMap<string, number>,
): RegionMaxValuePlan["overflow"] {
  const baselineNet = resolveNetByItem(baseline);
  const maxNet = resolveNetByItem(maxValue);
  let best: RegionMaxValuePlan["overflow"] = null;
  for (const [itemId, value] of valueByItemId) {
    const delta = (maxNet.get(itemId) ?? 0) - (baselineNet.get(itemId) ?? 0);
    if (delta <= EPSILON || value <= 0) {
      continue;
    }
    const valuePerMinute = delta * value;
    if (best === null || valuePerMinute > best.valuePerMinute) {
      best = {
        itemId,
        name: resolveItemName(baseline, itemId),
        value,
        perMinute: delta,
        valuePerMinute,
      };
    }
  }
  return best;
}

function resolveNetByItem(plan: RegionPlan): Map<string, number> {
  const net = new Map<string, number>();
  for (const total of plan.result.itemTotals) {
    net.set(total.itemId, total.producedPerMinute - total.demandPerMinute);
  }
  return net;
}

function resolveItemName(plan: RegionPlan, itemId: string): string {
  const shipped = plan.metrics.shipped.find((entry) => entry.itemId === itemId);
  if (shipped !== undefined) {
    return shipped.name;
  }
  const missed = plan.metrics.unresolved.find((entry) => entry.itemId === itemId);
  return missed?.name ?? lookupRegistryText(itemId);
}

export function analyzeBase(
  registry: RegistryContract,
  base: BaseDefinition,
  options: RegionProductionOptions,
): RegionAnalysis {
  const index = createRegionProductionIndex(registry, base);
  // 只保留当前求解范围内存在的物品：活动限定物品默认不在建模范围内，不应被误报为「缺口」。
  const valuable = resolveRegionValuableItems(registry, base)
    .filter((item) => index.itemById.has(item.itemId));
  const { producible, gaps } = resolveProducibleValuableItems(index, valuable);
  const valueByItemId = toValueMap(valuable);

  const variables = buildRegionLpVariables(index);
  const shared = buildSharedLpOptions(index, options, valueByItemId);
  const baselineTargets = toRateMap(producible, options.targetPerMinute);

  const allResource = solvePlan(index, variables, {
    ...shared,
    targets: baselineTargets,
    objective: "area",
  });

  const valueRanking = computeValueEfficiencyRanking(index, producible, options, variables, shared);

  const maxValuePlan = solvePlan(index, variables, {
    ...shared,
    targets: baselineTargets,
    objective: "value",
  });

  const budget = options.areaBudget;
  const baselineArea = allResource.metrics.deviceArea;
  const remainingArea = budget - baselineArea;

  return {
    base,
    options,
    valuable,
    producible,
    gaps,
    allResource,
    valueRanking,
    maxValue: {
      ...maxValuePlan,
      budget,
      baselineArea,
      remainingArea,
      areaUtilization: budget > EPSILON ? maxValuePlan.metrics.deviceArea / budget : 0,
      overflow: resolveOverflow(allResource, maxValuePlan, valueByItemId),
    },
  };
}