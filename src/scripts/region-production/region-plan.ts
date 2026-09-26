/**
 * 区域产线建模 · 配比求解层（L2）
 *
 * 在「地区范围」给定的前提下，产出：
 * 1. 全资源基础计划：该地区每种可产券物品各 1 份基础速率，保证探索期不缺料；
 * 2. 单位面积价值排名：逐物品求解单条产线，得到「价值/分钟/格」的边际效率；
 * 3. 最高单位面积价值计划：基础计划之外，用剩余面积按最高边际效率追加高价值产线。
 *
 * 说明：采掘设备（矿机 / 水泵 / 种植机）不作为普通设备参与求解，其产量以区域资源池表达。
 *
 * AI-CORRECTION 2026-09-26: 上述第 9-10 行的「采掘设备作为普通设备参与求解」已失效。
 * 原因：用户确认矿机、气矿机、水泵等采集设备放在基地之外，不占基地区域面积。
 * 新行为：`自然资源采集` 配方不进入 LP 变量集合，不参与面积计算；其产物改由「区域共享资源池上限」供给。
 *
 * AI-CORRECTION 2026-09-26: 本层由「单基地求解」升级为「区域级统一求解后分摊」。
 * 原因：区域资源池按大区域共享，若逐基地各自求解会把同一份资源上限按基地数量重复放大。
 * 新行为：同一地区内多个基地的变量在一次 LP 内联立 —— 物料平衡与基线区域共享，面积预算按基地独立；
 * 求解后再按基地拆分设备配置（见 allocations）。
 *
 * AI-CORRECTION 2026-09-26: 上述第 7 行的「基础计划之外，用剩余面积按最高边际效率追加」已失效。
 * 原因：改用区域级 LP 直接求「价值/分钟最大」，不再依赖单位面积边际效率做贪心追加（排名仅作参考展示）。
 * 新行为：maxValue 由 solveMaxValuePlan 给出 —— 面积预算预留 EDA 整数化余量，价值最优后再取面积最小解；
 * overflow 仅描述相对基础计划多产出的最高价值物品。
 */

import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { BaseDefinition } from "@/domain/registry/types/base-definition";
import {
  buildProductionPlanningIndex,
  computeItemDefaultPerMinute,
  type ProductionPlanningIndex,
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
  buildRegionLpVariables,
  resolveInfiniteSupplyItemIds,
  resolveNaturalResourceItemIds,
  solveRegionLp,
  toProductionPlanningResult,
  type RegionLpBuild,
  type RegionLpOptions,
  type RegionLpVariable,
} from "./lp/region-lp";
import {
  createRegionScopedRegistry,
  resolveRegionValuableItems,
  type RegionValuableItem,
} from "./region-scope";
import type { RegionResourceLimits } from "./region-resources";

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

/** 效率排名用单基地变量求解，给一个不会截断的最小面积搜索预算。 */
const EFFICIENCY_AREA_BUDGET = 1e6;

export interface RegionProductionOptions {
  /** 全资源基础计划中，每种物品的目标速率（每分钟）。 */
  readonly targetPerMinute: number;
  /** 区域自然资源外部供给上限（每分钟）；按区域共享，来自版本资源预设。 */
  readonly resourceLimits: ReadonlyMap<string, number>;
  /** 版本资源预设声明的无限供给物品（如清水、沉积酸）。 */
  readonly infiniteItemIds: ReadonlySet<string>;
  readonly sourceConfig: ProductionPlanningSourceConfig;
}

// AI-REMOVED 2026-09-26:
// Reason: 单基地面积预算字段在区域级求解下没有意义（面积预算必须按基地分别给出）。
// Trigger: 用户确认「区域级统一求解后分摊」。
// Evidence: lp/region-lp.ts 的 RegionLpOptions.baseAreaBudget 已改为按基地映射。
// Replacement: analyzeRegion 内部由 bases 的 placeableArea 直接推导，不再经由此选项传递。
// Risk: Low
// Human Review: Required
//
// Original code:
//   /** 可占用面积预算（格）；缺省为基地可摆放面积。 */
//   readonly areaBudget: number;

export function createDefaultRegionProductionOptions(
  resourceLimits: RegionResourceLimits | null,
  overrides: Partial<RegionProductionOptions> = {},
): RegionProductionOptions {
  return {
    targetPerMinute: overrides.targetPerMinute ?? 1,
    resourceLimits: overrides.resourceLimits ?? resourceLimits?.limits ?? new Map<string, number>(),
    infiniteItemIds: overrides.infiniteItemIds ?? resourceLimits?.infiniteItemIds ?? new Set<string>(),
    sourceConfig: overrides.sourceConfig ?? { ...DEFAULT_SOURCE_CONFIG },
  };
}

export interface RegionPlan {
  readonly result: ReturnType<typeof toProductionPlanningResult>;
  readonly metrics: ProductionPlanMetrics;
}

/** 求解结果：指标之外保留变量取值，供区域级结果按基地拆分。 */
interface RegionSolve {
  readonly plan: RegionPlan;
  readonly build: RegionLpBuild;
  readonly deviceCounts: readonly number[];
  /** 线性规划目标值：objective 为 value 时是价值/分钟，为 area 时是 `-占地格`。 */
  readonly objectiveValue: number;
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

/** 区域最优配置在某基地上的分摊结果。 */
export interface BaseAllocation {
  readonly base: BaseDefinition;
  readonly areaBudget: number;
  readonly plan: RegionPlan;
}

export interface RegionAnalysis {
  readonly regionTag: string;
  readonly bases: readonly BaseDefinition[];
  readonly options: RegionProductionOptions;
  readonly resourceLimits: RegionResourceLimits | null;
  readonly valuable: RegionValuableItem[];
  readonly producible: RegionValuableItem[];
  readonly gaps: RegionValuableItem[];
  /** 区域级全资源基础计划（面积最小化）。 */
  readonly allResource: RegionPlan;
  readonly valueRanking: ValueEfficiencyEntry[];
  /** 区域级价值最大化计划。 */
  readonly maxValue: RegionMaxValuePlan;
  /** 区域最优配置按基地分摊。 */
  readonly allocations: readonly BaseAllocation[];
  /** 求解范围内物品的显示名，供报告层直接渲染（如区域资源池条目）。 */
  readonly itemNameById: ReadonlyMap<string, string>;
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
  baseAreaBudget: ReadonlyMap<string, number>,
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
  // 无限供应来自两处：物品自带 `无限供应` tag，以及版本资源预设显式声明（如清水、沉积酸）。
  const infiniteItemIds = resolveInfiniteSupplyItemIds(index);
  for (const itemId of options.infiniteItemIds) {
    infiniteItemIds.add(itemId);
  }
  return {
    baseAreaBudget,
    valueByItemId,
    resourceLimits: options.resourceLimits,
    infiniteItemIds,
    naturalResourceItemIds: resolveNaturalResourceItemIds(index),
    dumpableItemIds,
  };
}

/** 求解一次区域线性规划并折算为 RegionPlan；基线不可行时退回无基线求解。 */
function solvePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: RegionLpOptions,
): RegionSolve {
  let attempt = solveRegionLp(lpOptions, variables);
  if (attempt.solution.status !== "optimal" && lpOptions.targets.size > 0) {
    attempt = solveRegionLp({ ...lpOptions, targets: new Map() }, variables);
  }
  if (attempt.solution.status !== "optimal") {
    throw new Error(`区域线性规划未取得最优解：${attempt.solution.status}`);
  }
  const { build, deviceCounts } = attempt;
  const result = toProductionPlanningResult(
    build.variables,
    deviceCounts,
    build.itemIds,
    build.externalSupplyItemIds,
    "region",
  );
  return {
    plan: {
      result,
      metrics: computePlanMetrics({
        result,
        index,
        shipped: resolveShipped(result, lpOptions.valueByItemId),
      }),
    },
    build,
    deviceCounts,
    objectiveValue: attempt.solution.objectiveValue,
  };
}

// AI-REMOVED 2026-09-26:
// Reason: 「每个被使用配方各预留 1 台 footprint」过于保守 —— 实际取整超出量平均只有约半台，
//   武陵因此白丢约 945 格（价值 18027→16650，利用率 93.2%），而真实溢出只有 177 格。
// Trigger: 需要在不牺牲可行性的前提下把价值与面积利用率拉回接近连续最优。
// Evidence: node src/scripts/region-production/run.mjs --regions 武陵 的对比（前 16649.69/min @93.2%）。
// Replacement: solveMaxValuePlan 改为按「实际整数化超出量」收紧面积预算（resolveCeilOverflowByBase）。
// Risk: Low
// Human Review: Required
//
// Original code:
// function resolveIntegerizationReserve(
//   deviceCounts: readonly number[],
//   variables: readonly RegionLpVariable[],
// ): Map<string, number> {
//   const reserve = new Map<string, number>();
//   for (let column = 0; column < variables.length; column++) {
//     if ((deviceCounts[column] ?? 0) <= EPSILON) {
//       continue;
//     }
//     const variable = variables[column]!;
//     reserve.set(variable.baseId, (reserve.get(variable.baseId) ?? 0) + variable.deviceArea);
//   }
//   return reserve;
// }
//
// function isReserveSufficient(
//   required: ReadonlyMap<string, number>,
//   reserve: ReadonlyMap<string, number>,
// ): boolean {
//   for (const [baseId, area] of required) {
//     if ((reserve.get(baseId) ?? 0) < area - EPSILON) {
//       return false;
//     }
//   }
//   return true;
// }

function subtractReserve(
  budget: ReadonlyMap<string, number>,
  reserve: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [baseId, area] of budget) {
    result.set(baseId, area - (reserve.get(baseId) ?? 0));
  }
  return result;
}

/** 面积收紧迭代上限；每轮按实际整数化超出量收紧预算，预算单调下降。 */
const AREA_TIGHTEN_ITERATIONS = 12;

/**
 * 求「价值最大、同价值下面积最小」的规范化最优解，并保证该解经 EDA 整数化后仍放得下。
 *
 * 两级修正：
 * - 面积收紧：EDA 会把每个配方的台数向上取整成整数台（见 blueprint-planner/production-network.ts 的
 *   `Math.ceil(plan.deviceCount)`），连续解直接交给 EDA 必然超预算（原实现武陵为 14077 > 13900 格）。
 *   这里按「实际超出量」逐轮收紧面积预算并重解，直到整数化占地落在原预算内，避免过度预留。
 * - 面积次目标：价值相同时取占地最小解，消除零价值设备（净水节点等）在多重最优解里出现的伪影。
 */
function solveMaxValuePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: RegionLpOptions,
): RegionSolve {
  let budget = new Map(lpOptions.baseAreaBudget);
  let overflow = new Map<string, number>();
  for (let iteration = 0; iteration < AREA_TIGHTEN_ITERATIONS; iteration++) {
    // 价值下界给相对容差，避免浮点误差把价值最优解判成不可行。
    const solved = solvePlan(index, variables, { ...lpOptions, baseAreaBudget: budget });
    const canonical = solvePlan(index, variables, {
      ...lpOptions,
      baseAreaBudget: budget,
      objective: "area",
      valueFloor: solved.objectiveValue - (1e-6 + Math.abs(solved.objectiveValue) * 1e-9),
    });
    overflow = resolveCeilOverflowByBase(canonical.deviceCounts, variables, lpOptions.baseAreaBudget);
    if (overflow.size === 0) {
      assertCeilAreaWithinBudget(canonical.deviceCounts, variables, lpOptions.baseAreaBudget);
      return canonical;
    }
    budget = subtractReserve(budget, overflow);
  }

  // 收紧未收敛说明模型前提被破坏，直接报错而不是静默输出超预算解。
  const detail = [...overflow].map(([baseId, excess]) => `${baseId}=+${excess}`).join("，");
  throw new Error(`面积收紧在 ${AREA_TIGHTEN_ITERATIONS} 轮内未收敛（${detail}）。`);
}

/** 各基地「整数化占地 - 原预算」的正超出量；无超出时不返回该基地。 */
function resolveCeilOverflowByBase(
  deviceCounts: readonly number[],
  variables: readonly RegionLpVariable[],
  budget: ReadonlyMap<string, number>,
): Map<string, number> {
  const ceilAreaByBase = resolveCeilAreaByBase(deviceCounts, variables);
  const overflow = new Map<string, number>();
  for (const [baseId, area] of budget) {
    const excess = (ceilAreaByBase.get(baseId) ?? 0) - area;
    if (excess > EPSILON) {
      overflow.set(baseId, excess);
    }
  }
  return overflow;
}

/** 按 EDA 口径（每配方向上取整）折算各基地占地，用于复核可行性。 */
function resolveCeilAreaByBase(
  deviceCounts: readonly number[],
  variables: readonly RegionLpVariable[],
): Map<string, number> {
  const areas = new Map<string, number>();
  for (let column = 0; column < variables.length; column++) {
    const count = deviceCounts[column] ?? 0;
    if (count <= EPSILON) {
      continue;
    }
    const variable = variables[column]!;
    const ceilArea = Math.ceil(count - EPSILON) * variable.deviceArea;
    areas.set(variable.baseId, (areas.get(variable.baseId) ?? 0) + ceilArea);
  }
  return areas;
}

/** 兜底断言：整数化占地必须落在最初给定的基地预算内，否则说明余量推导有误。 */
function assertCeilAreaWithinBudget(
  deviceCounts: readonly number[],
  variables: readonly RegionLpVariable[],
  budget: ReadonlyMap<string, number>,
): void {
  const ceilAreaByBase = resolveCeilAreaByBase(deviceCounts, variables);
  for (const [baseId, area] of budget) {
    const ceilArea = ceilAreaByBase.get(baseId) ?? 0;
    if (ceilArea > area + EPSILON) {
      throw new Error(`基地「${baseId}」整数化占地 ${ceilArea} 格超出预算 ${area} 格。`);
    }
  }
}

/** LP 解的券价值外送：净产出为正且登记了价值的物品。 */
function resolveShipped(
  result: ProductionPlanningResult,
  valueByItemId: ReadonlyMap<string, number>,
): { itemId: string; perMinute: number; value: number }[] {
  const shipped: { itemId: string; perMinute: number; value: number }[] = [];
  for (const total of result.itemTotals) {
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

/**
 * 逐物品求解单条产线，得到单位面积价值效率排名（降序）。
 * 效率是「一条产线」的边际属性，与区域里有几个基地无关，因此固定用单基地变量求解，
 * 避免对每个物品都跑一次完整区域 LP。
 */
export function computeValueEfficiencyRanking(
  index: ProductionPlanningIndex,
  producible: readonly RegionValuableItem[],
  options: RegionProductionOptions,
  shared: Omit<RegionLpOptions, "targets" | "objective">,
): ValueEfficiencyEntry[] {
  const probeBaseId = "__efficiency__";
  const probeVariables = buildRegionLpVariables(index, probeBaseId);
  const probeShared = {
    ...shared,
    baseAreaBudget: new Map([[probeBaseId, EFFICIENCY_AREA_BUDGET]]),
  };
  const entries: ValueEfficiencyEntry[] = [];
  for (const item of producible) {
    const rate = Math.max(computeItemDefaultPerMinute(item.itemId, index), options.targetPerMinute);
    const solved = solvePlan(index, probeVariables, {
      ...probeShared,
      targets: new Map([[item.itemId, rate]]),
      objective: "area",
    });
    const deviceArea = solved.plan.metrics.deviceArea;
    const areaPerUnitPerMinute = deviceArea / rate;
    const valuePerMinute = rate * item.value;
    entries.push({
      itemId: item.itemId,
      name: lookupRegistryText(item.nameKey),
      value: item.value,
      perMinute: rate,
      deviceArea,
      areaPerUnitPerMinute,
      deviceCount: solved.plan.metrics.totalDeviceCountCeil,
      powerDemandPerTick: solved.plan.metrics.powerDemandPerTick,
      valuePerMinute,
      valuePerArea: deviceArea > EPSILON ? valuePerMinute / deviceArea : Number.POSITIVE_INFINITY,
      machineUsages: solved.plan.metrics.machineUsages,
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

/** 把区域最优解按基地拆成各自的设备配置；基地口径下跨基地流转不计为缺口。 */
function splitByBase(
  index: ProductionPlanningIndex,
  bases: readonly BaseDefinition[],
  build: RegionLpBuild,
  deviceCounts: readonly number[],
  valueByItemId: ReadonlyMap<string, number>,
): BaseAllocation[] {
  return bases.map((base) => {
    const subVariables: RegionLpVariable[] = [];
    const subCounts: number[] = [];
    for (let column = 0; column < build.variables.length; column++) {
      const variable = build.variables[column]!;
      if (variable.baseId !== base.id) {
        continue;
      }
      subVariables.push(variable);
      subCounts.push(deviceCounts[column] ?? 0);
    }
    const result = toProductionPlanningResult(
      subVariables,
      subCounts,
      build.itemIds,
      build.externalSupplyItemIds,
      "base",
    );
    return {
      base,
      areaBudget: base.placeableArea.width * base.placeableArea.height,
      plan: {
        result,
        metrics: computePlanMetrics({
          result,
          index,
          shipped: resolveShipped(result, valueByItemId),
        }),
      },
    };
  });
}

/**
 * 对同一地区的多个基地做区域级统一求解：
 * 资源池区域共享、面积预算按基地独立，求解后按基地拆分设备配置。
 */
export function analyzeRegion(
  registry: RegistryContract,
  regionTag: string,
  bases: readonly BaseDefinition[],
  options: RegionProductionOptions,
  resourceLimits: RegionResourceLimits | null,
): RegionAnalysis {
  if (bases.length === 0) {
    throw new Error(`区域「${regionTag}」没有可建模基地。`);
  }
  const referenceBase = bases[0]!;
  const index = createRegionProductionIndex(registry, referenceBase);
  // 只保留当前求解范围内存在的物品：活动限定物品默认不在建模范围内，不应被误报为「缺口」。
  const valuable = resolveRegionValuableItems(registry, referenceBase)
    .filter((item) => index.itemById.has(item.itemId));
  const { producible, gaps } = resolveProducibleValuableItems(index, valuable);
  const valueByItemId = toValueMap(valuable);

  const variables: RegionLpVariable[] = [];
  const baseAreaBudget = new Map<string, number>();
  for (const base of bases) {
    variables.push(...buildRegionLpVariables(index, base.id));
    baseAreaBudget.set(base.id, base.placeableArea.width * base.placeableArea.height);
  }

  const shared = buildSharedLpOptions(index, options, valueByItemId, baseAreaBudget);
  const baselineTargets = toRateMap(producible, options.targetPerMinute);

  const allResource = solvePlan(index, variables, {
    ...shared,
    targets: baselineTargets,
    objective: "area",
  });

  const valueRanking = computeValueEfficiencyRanking(index, producible, options, shared);

  const maxValueSolve = solveMaxValuePlan(index, variables, {
    ...shared,
    targets: baselineTargets,
    objective: "value",
  });

  const budget = [...baseAreaBudget.values()].reduce((sum, area) => sum + area, 0);
  const baselineArea = allResource.plan.metrics.deviceArea;
  const remainingArea = budget - baselineArea;

  const itemNameById = new Map<string, string>();
  for (const item of index.itemById.values()) {
    itemNameById.set(item.id, lookupRegistryText(item.nameKey));
  }

  return {
    regionTag,
    bases,
    options,
    resourceLimits,
    valuable,
    producible,
    gaps,
    allResource: allResource.plan,
    valueRanking,
    maxValue: {
      ...maxValueSolve.plan,
      budget,
      baselineArea,
      remainingArea,
      areaUtilization: budget > EPSILON ? maxValueSolve.plan.metrics.deviceArea / budget : 0,
      overflow: resolveOverflow(allResource.plan, maxValueSolve.plan, valueByItemId),
    },
    allocations: splitByBase(index, bases, maxValueSolve.build, maxValueSolve.deviceCounts, valueByItemId),
    itemNameById,
  };
}