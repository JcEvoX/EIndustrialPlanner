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
 */

import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { BaseDefinition } from "@/domain/registry/types/base-definition";
import {
  buildProductionPlanningIndex,
  computeItemDefaultPerMinute,
  computeProductionPlan,
  type ProductionPlanningIndex,
  type ProductionPlanningPort,
  type ProductionPlanningResult,
  type ProductionPlanningSourceConfig,
} from "@/app/shell/production-planning/production-planning-model";
import {
  computePlanMetrics,
  lookupRegistryText,
  type MachineUsage,
  type ProductionPlanMetrics,
} from "./plan-metrics";
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

export interface RegionProductionOptions {
  /** 全资源基础计划中，每种物品的目标速率（每分钟）。 */
  readonly targetPerMinute: number;
  /** 可占用面积预算（格）；缺省为基地可摆放面积。 */
  readonly areaBudget: number;
  readonly sourceConfig: ProductionPlanningSourceConfig;
}

export function createDefaultRegionProductionOptions(
  base: BaseDefinition,
  overrides: Partial<RegionProductionOptions> = {},
): RegionProductionOptions {
  return {
    targetPerMinute: overrides.targetPerMinute ?? 1,
    areaBudget: overrides.areaBudget ?? base.placeableArea.width * base.placeableArea.height,
    sourceConfig: overrides.sourceConfig ?? { ...DEFAULT_SOURCE_CONFIG },
  };
}

export interface RegionPlan {
  readonly result: ProductionPlanningResult;
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

/** 求解一次物料平衡；targets 以 itemId 合并，避免同一物品出现多个根节点。 */
function solve(
  index: ProductionPlanningIndex,
  targetRates: ReadonlyMap<string, number>,
  valueByItemId: ReadonlyMap<string, number>,
  sourceConfig: ProductionPlanningSourceConfig,
): RegionPlan {
  const targets: ProductionPlanningPort[] = [];
  for (const [itemId, perMinute] of targetRates) {
    if (perMinute > EPSILON) {
      targets.push({ id: `target:${itemId}`, itemId, perMinute });
    }
  }
  const result = computeProductionPlan(
    {
      targets,
      supplies: [],
      infiniteItemIds: new Set<string>(),
      recipeChoices: new Map<string, string>(),
      sourceConfig,
    },
    index,
  );
  const shipped = targets.map((target) => ({
    itemId: target.itemId,
    perMinute: target.perMinute,
    value: valueByItemId.get(target.itemId) ?? 0,
  }));
  return { result, metrics: computePlanMetrics({ result, index, shipped }) };
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
): ValueEfficiencyEntry[] {
  const entries: ValueEfficiencyEntry[] = [];
  for (const item of producible) {
    const rate = Math.max(computeItemDefaultPerMinute(item.itemId, index), options.targetPerMinute);
    const plan = solve(index, new Map([[item.itemId, rate]]), new Map([[item.itemId, item.value]]), options.sourceConfig);
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

  const baselineRates = toRateMap(producible, options.targetPerMinute);
  const allResource = solve(index, baselineRates, valueByItemId, options.sourceConfig);

  const valueRanking = computeValueEfficiencyRanking(index, producible, options);

  const budget = options.areaBudget;
  const baselineArea = allResource.metrics.deviceArea;
  const remainingArea = budget - baselineArea;

  let overflow: RegionMaxValuePlan["overflow"] = null;
  const maxValueRates = new Map(baselineRates);
  const best = valueRanking[0];
  if (remainingArea > EPSILON && best !== undefined && best.areaPerUnitPerMinute > EPSILON) {
    const overflowPerMinute = remainingArea / best.areaPerUnitPerMinute;
    if (overflowPerMinute > EPSILON) {
      maxValueRates.set(best.itemId, (maxValueRates.get(best.itemId) ?? 0) + overflowPerMinute);
      overflow = {
        itemId: best.itemId,
        name: best.name,
        value: best.value,
        perMinute: overflowPerMinute,
        valuePerMinute: overflowPerMinute * best.value,
      };
    }
  }

  const maxValuePlan = solve(index, maxValueRates, valueByItemId, options.sourceConfig);

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
      overflow,
    },
  };
}