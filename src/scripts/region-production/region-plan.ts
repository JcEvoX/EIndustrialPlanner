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
 *
 * AI-CORRECTION 2026-09-26: 上述「价值/分钟最大」已收敛为「高价值物品价值/分钟最大」。
 * 原因：全量价值等权累加时，任何单位面积为正的产线都值得建满，有限资源用尽后的剩余面积必然被
 * 「低价值 + 无限原料」的产线填充（武陵因此多产 2239/min 的息壤，价值 1）。
 * 新行为：目标只累加 value >= highValueThreshold 的物品（见 RegionProductionOptions），
 * 且词典序由两层扩为三层 —— 价值 → 均衡 → 面积（均衡见 BaseAllocation 的基地分摊）。
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
  type RegionLpResult,
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

/**
 * 默认高价值门槛（调度券价值）。
 * 取 25：该值及以上是「优质 / 精选级成品」（四号谷地 6 种、武陵 5 种），
 * 恰好把 1/2/3/10/16/22 的基础件与低级成品排除在目标之外。可经 CLI `--high-value-threshold` 覆盖。
 */
export const DEFAULT_HIGH_VALUE_THRESHOLD = 25;

export interface RegionProductionOptions {
  /** 全资源基础计划中，每种物品的目标速率（每分钟）。 */
  readonly targetPerMinute: number;
  /**
   * 高价值门槛（调度券价值）：只有 value >= 该值的物品参与「最高价值计划」的目标函数。
   * 门槛以下的物品仍受基线约束（每种可生产物品 >= targetPerMinute），也仍可作高价值产线的中间物
   * 或副产物顺带产出，但不会为它们专门占用面积。
   *
   * 设 0 表示不做门槛过滤，恢复「所有券价值等权累加」的旧口径（有限资源用尽后剩余面积会被
   * 低价值产线填满）。DEFAULT_HIGH_VALUE_THRESHOLD 为默认门槛，见 createDefaultRegionProductionOptions。
   */
  readonly highValueThreshold: number;
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
    highValueThreshold: overrides.highValueThreshold ?? DEFAULT_HIGH_VALUE_THRESHOLD,
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
  /**
   * 区域全资源基础计划按基地分摊。
   *
   * 与 `allocations`（最高价值计划的基地分摊）并列：最高价值计划的定义是「用剩余面积追加产线」，
   * 其面积占用天然贴着基地上限，无法整台落地为蓝图；基础计划密度低得多，是可落地的基地配置来源。
   */
  readonly baseAllocations: readonly BaseAllocation[];
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

// AI-REMOVED 2026-10-01:
// Reason: 该函数把「可产」判定与「可产性探测」割裂开 —— 判定只能靠静态条件（有配方 + 图可达），
//   而图可达口径会把自增殖循环误判为不可达（见 lp/region-lp.ts 的 AI-REMOVED 记录）。
// Trigger: 用户要求「按区域资源裁剪配方」后，武陵可产券物品由 12 种掉到 6 种（锦草软饮/芽针针剂/
//   武陵电池被误判为缺口），基线保底随之丢失。
// Evidence: .temp/.trash/region-probe2/ 下 diag.mjs / diag-item.mjs 实测；见 lp/region-lp.ts 同级记录。
// Replacement: 下方 probeRegionValuableItems —— 直接用 LP 可行性判定，并与单位面积价值排名合并为同一轮探测。
// Risk: Low
// Human Review: Required
//
// Original code:
// /**
//  * 区分「该地区可自动生产」与「该地区不可生产」的券价值物品。
//  *
//  * AI-CORRECTION 2026-10-01: 原判定「有系统配方候选即可产」不成立，已追加资源可达性要求。
//  * 原因：候选只校验设备可摆放（见 region-scope.ts 的地区裁剪），不校验配方链所需的资源能否在本区闭环。
//  * 后果是「本区缺资源的券物品」也会被列为可产并进入基线目标，把整条基线拖成不可行。
//  * 新行为：可产 = 本区存在系统配方候选 且 物品落在资源可达闭包内（见 resolveResourceReachableItemIds）；
//  * 其余归入 gaps，报告层按「需跨区或外部供给」列出。
//  */
// export function resolveProducibleValuableItems(
//   index: ProductionPlanningIndex,
//   valuable: readonly RegionValuableItem[],
//   reachableItemIds: ReadonlySet<string>,
// ): { producible: RegionValuableItem[]; gaps: RegionValuableItem[] } {
//   const producible: RegionValuableItem[] = [];
//   const gaps: RegionValuableItem[] = [];
//   for (const item of valuable) {
//     const candidates = index.candidatesByOutputItem.get(item.itemId) ?? [];
//     const hasRecipe = candidates.some((candidate) => candidate.sourceType === "system-recipe");
//     if (hasRecipe && reachableItemIds.has(item.itemId)) {
//       producible.push(item);
//     } else {
//       gaps.push(item);
//     }
//   }
//   return { producible, gaps };
// }

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
  // 目标价值只保留达到门槛的物品：门槛以下系数为 0，求解器不会为其专门占用面积。
  const objectiveValueByItemId = new Map<string, number>();
  for (const [itemId, value] of valueByItemId) {
    if (value > 0 && value >= options.highValueThreshold) {
      objectiveValueByItemId.set(itemId, value);
    }
  }
  return {
    baseAreaBudget,
    valueByItemId,
    objectiveValueByItemId,
    resourceLimits: options.resourceLimits,
    infiniteItemIds,
    naturalResourceItemIds: resolveNaturalResourceItemIds(index),
    dumpableItemIds,
  };
}

/**
 * 求解一次区域线性规划并折算为 RegionPlan。
 *
 * AI-CORRECTION 2026-10-01: 原行为「基线不可行时退回无基线求解」已失效。
 * 原因：该降级是静默的 —— 只要有一个券物品在本区产不出来，「每种可产物品各 1/min」的保底会整体
 *   消失且不报错，调用方与报告层都无法察觉；且它掩盖了真正的建模缺陷。
 * 新行为：基线目标只包含本区可产的券物品（见 probeRegionValuableItems），因此基线在口径内必然可行；
 *   若仍不可行，说明模型前提被破坏（如面积预算压到装不下保底产线），直接报错并带上基线目标条数。
 */
function solvePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: RegionLpOptions,
): RegionSolve {
  const attempt = solveRegionLp(lpOptions, variables);
  if (attempt.solution.status !== "optimal") {
    const scope = lpOptions.targets.size > 0 ? `（基线目标 ${lpOptions.targets.size} 项）` : "";
    throw new Error(`区域线性规划未取得最优解：${attempt.solution.status}${scope}`);
  }
  // AI-REMOVED 2026-10-01:
  // Reason: 该降级会在基线不可行时静默丢弃全部基线目标，使「保底不缺料」整体消失且无任何信号。
  // Trigger: 用户确认「按区域资源裁剪配方」口径 —— 基线只应包含本区可产的券物品，
  //   不可产者应显式暴露为缺口，而不是把整条基线悄悄降级。
  // Evidence: 可产口径已由 analyzeRegion 的 probeRegionValuableItems 用 LP 判定（同 fail-closed 资源上限）。
  // Replacement: 上方直接抛错（带基线目标条数）。
  // Risk: Low —— 若后续资源预设漏登记，基线会从「静默降级」变为「显式报错」，属预期的数据校验信号。
  // Human Review: Required
  //
  // Original code:
  // let attempt = solveRegionLp(lpOptions, variables);
  // if (attempt.solution.status !== "optimal" && lpOptions.targets.size > 0) {
  //   attempt = solveRegionLp({ ...lpOptions, targets: new Map() }, variables);
  // }
  // if (attempt.solution.status !== "optimal") {
  //   throw new Error(`区域线性规划未取得最优解：${attempt.solution.status}`);
  // }
  // const { build, deviceCounts } = attempt;
  return toRegionSolve(index, attempt, lpOptions);
}

/** 把一次已取得最优解的 LP 结果折算为 RegionSolve；供 solvePlan 与可产性探测共用。 */
function toRegionSolve(
  index: ProductionPlanningIndex,
  attempt: RegionLpResult,
  lpOptions: Pick<RegionLpOptions, "valueByItemId">,
): RegionSolve {
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
 * 求「价值最大 → 面积最小 → 最小基地利用率最大」的规范化最优解，并保证该解经 EDA 整数化后仍放得下。
 *
 * 三级词典序 + 一级工程修正：
 * - 价值层：目标为达到高价值门槛的物品净值最大（门槛见 RegionProductionOptions）；
 * - 面积层：锁定价值下界后取占地最小解，消除零价值设备在多重最优解里出现的伪影；
 * - 均衡层：锁定价值与面积后最大化「最小基地利用率」t（见 buildRegionLp 的均衡行），
 *   把设备在等价最优解里摊到各基地，避免全塞进变量序靠前的那一个；
 * - 面积收紧：EDA 会把每个配方的台数向上取整成整数台（见 blueprint-planner/production-network.ts 的
 *   `Math.ceil(plan.deviceCount)`），连续解直接交给 EDA 必然超预算（原实现武陵为 14077 > 13900 格）。
 *   这里按「实际超出量」逐轮收紧面积预算并重解，直到整数化占地落在原预算内，避免过度预留。
 *
 * AI-CORRECTION 2026-09-26: 原实现只有「价值 → 面积」两层，缺少均衡层，且面积层原本兼作末层。
 * 原因：目标函数对基地无偏好，单纯形按列序取变量 —— 面积富余的四号谷地把全部设备塞进变量序
 * 最前的协议核心区（241 台），其余三个基地为空；面积吃紧的武陵反而自然摊开。
 * 新行为：均衡层排在面积层之后 —— 先锁死面积最优，再在「同价值同面积」的解集内最大化最小利用率。
 * 该顺序是刻意的：若把均衡排在面积之前，均衡会靠新增低价值设备来抬高最空基地的利用率。
 */
function solveMaxValuePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: RegionLpOptions,
): RegionSolve {
  let budget = new Map(lpOptions.baseAreaBudget);
  let overflow = new Map<string, number>();
  for (let iteration = 0; iteration < AREA_TIGHTEN_ITERATIONS; iteration++) {
    // 下界一律给相对容差，避免浮点误差把上一层的最优解判成不可行。
    const valueSolved = solvePlan(index, variables, { ...lpOptions, baseAreaBudget: budget });
    const valueFloor = valueSolved.objectiveValue
      - (1e-6 + Math.abs(valueSolved.objectiveValue) * 1e-9);
    const areaSolved = solvePlan(index, variables, {
      ...lpOptions,
      baseAreaBudget: budget,
      objective: "area",
      valueFloor,
    });
    // objective 为 area 时目标值是 `-占地格`，取负即连续最优面积。
    const areaFloor = -areaSolved.objectiveValue
      + (1e-6 + Math.abs(areaSolved.objectiveValue) * 1e-9);
    const canonical = solvePlan(index, variables, {
      ...lpOptions,
      baseAreaBudget: budget,
      objective: "balance",
      valueFloor,
      areaFloor,
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

/**
 * 全资源基础计划：先面积最小，再在「同面积最优」的解集内最大化最小基地利用率（均衡层）。
 *
 * AI-CORRECTION 2026-09-26: 原实现只做「面积最小」一层，多重最优解被单纯形按列序取变量 ——
 * 面积富余的地区会把全部设备塞进变量序最前的协议核心区（武陵 base 计划 30 台全落协议核心区，
 * 其余三个基地为空），无法为每个基地产出可落地的蓝图。
 * 原因：目标函数对基地无偏好，最小面积解不唯一，单纯形只返回其中一个角点。
 * 新行为：追加与 solveMaxValuePlan 同源的均衡层（第 3 层），面积锁定后把设备摊到各基地。
 * 该层不改变基础计划的面积最优性 —— `areaFloor` 锁定为连续最小面积，均衡只能在等价解内重分布，
 * 不能靠新增设备抬高最空基地的利用率。
 */
function solveBaselinePlan(
  index: ProductionPlanningIndex,
  variables: readonly RegionLpVariable[],
  lpOptions: Omit<RegionLpOptions, "objective">,
): RegionSolve {
  const areaSolved = solvePlan(index, variables, { ...lpOptions, objective: "area" });
  const areaFloor = -areaSolved.objectiveValue
    + (1e-6 + Math.abs(areaSolved.objectiveValue) * 1e-9);
  return solvePlan(index, variables, { ...lpOptions, objective: "balance", areaFloor });
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

export interface RegionValuableProbe {
  /** 本区能用区域资源池以正速率产出的券物品。 */
  readonly producible: RegionValuableItem[];
  /** 本区产不出的券物品（缺配方或缺资源），需跨区供给。 */
  readonly gaps: RegionValuableItem[];
  /** 可产物品的单位面积价值效率排名（降序）。 */
  readonly valueRanking: ValueEfficiencyEntry[];
}

/**
 * 逐物品探测「本区能否以正速率产出」，并对可产者给出单位面积价值效率排名（降序）。
 *
 * 判定方式：对每个券物品，用同一批单基地探针变量求解一次「目标 = 该物品净产出 ≥ 单机速率、
 * 目标函数 = 面积最小」的 LP。可解即本区可产；`infeasible` 即缺口 —— 该判定与求解器共用同一套
 * fail-closed 资源上限（见 lp/region-lp.ts 的 resolveExternalSupplyCap），因此「本区没有对应资源」
 * 的物品必然不可解，而种植/采种这类自增殖环会被正确识别为可解。
 *
 * AI-CORRECTION 2026-10-01: 本函数取代了「按图可达性判定可产 + 单独跑排名」的两段式实现。
 * 原因：图可达闭包会把「种植机(种子+清水→作物) + 采种机(作物→种子)」这类净产出为正的自增殖环
 *   判成不可达（环内物品的图入边都不在源集合里），武陵因此丢掉 6 种券物品的基线保底；
 *   而可产性本就是线性可行性问题，用求解器判定才准确。
 * 新行为：一次探测同时产出「可产 / 缺口 / 单位面积价值排名」，且不可产物品不再进入排名
 *   （旧实现会为不可产物品解出零设备的退化解，使 valuePerArea 变成 +Infinity 排到榜首）。
 * 风险：探测次数由「可产物品数」变为「全部券物品数」（本次两个地区各 12/14 次），单次求解规模不变。
 */
export function probeRegionValuableItems(
  index: ProductionPlanningIndex,
  valuable: readonly RegionValuableItem[],
  options: RegionProductionOptions,
  shared: Omit<RegionLpOptions, "targets" | "objective">,
): RegionValuableProbe {
  const probeBaseId = "__efficiency__";
  const probeVariables = buildRegionLpVariables(
    index,
    probeBaseId,
    options.sourceConfig.waterPurifierPolicy === "use-when-available",
  );
  const probeShared = {
    ...shared,
    baseAreaBudget: new Map([[probeBaseId, EFFICIENCY_AREA_BUDGET]]),
  };
  const producible: RegionValuableItem[] = [];
  const gaps: RegionValuableItem[] = [];
  const entries: ValueEfficiencyEntry[] = [];
  for (const item of valuable) {
    const rate = Math.max(computeItemDefaultPerMinute(item.itemId, index), options.targetPerMinute);
    const attempt = solveRegionLp(
      { ...probeShared, targets: new Map([[item.itemId, rate]]), objective: "area" },
      probeVariables,
    );
    if (attempt.solution.status === "infeasible") {
      gaps.push(item);
      continue;
    }
    if (attempt.solution.status !== "optimal") {
      throw new Error(`可产性探测未取得结论：${item.itemId} ${attempt.solution.status}`);
    }
    producible.push(item);
    const solved = toRegionSolve(index, attempt, shared);
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
  return {
    producible,
    gaps,
    valueRanking: entries.sort((left, right) => right.valuePerArea - left.valuePerArea),
  };
}

// AI-REMOVED 2026-10-01:
// Reason: 该函数只负责「可产物品的单位面积价值排名」，可产性由调用方另行静态判定；两者合并后
//   可产性改由 LP 可行性给出，该独立入口不再需要。
// Trigger: 用户要求「按区域资源裁剪配方」，静态可产判定被证明不可靠（见上方 probeRegionValuableItems）。
// Evidence: .temp/.trash/region-probe2/ 下 diag.mjs / diag-item.mjs 实测。
// Replacement: 上方 probeRegionValuableItems。
// Risk: Low
// Human Review: Required
//
// Original code:
// /**
//  * 逐物品求解单条产线，得到单位面积价值效率排名（降序）。
//  * 效率是「一条产线」的边际属性，与区域里有几个基地无关，因此固定用单基地变量求解，
//  * 避免对每个物品都跑一次完整区域 LP。
//  */
// export function computeValueEfficiencyRanking(
//   index: ProductionPlanningIndex,
//   producible: readonly RegionValuableItem[],
//   options: RegionProductionOptions,
//   shared: Omit<RegionLpOptions, "targets" | "objective">,
// ): ValueEfficiencyEntry[] {
//   const probeBaseId = "__efficiency__";
//   const probeVariables = buildRegionLpVariables(
//     index,
//     probeBaseId,
//     options.sourceConfig.waterPurifierPolicy === "use-when-available",
//   );
//   const probeShared = {
//     ...shared,
//     baseAreaBudget: new Map([[probeBaseId, EFFICIENCY_AREA_BUDGET]]),
//   };
//   const entries: ValueEfficiencyEntry[] = [];
//   for (const item of producible) {
//     const rate = Math.max(computeItemDefaultPerMinute(item.itemId, index), options.targetPerMinute);
//     const solved = solvePlan(index, probeVariables, {
//       ...probeShared,
//       targets: new Map([[item.itemId, rate]]),
//       objective: "area",
//     });
//     const deviceArea = solved.plan.metrics.deviceArea;
//     const areaPerUnitPerMinute = deviceArea / rate;
//     const valuePerMinute = rate * item.value;
//     entries.push({
//       itemId: item.itemId,
//       name: lookupRegistryText(item.nameKey),
//       value: item.value,
//       perMinute: rate,
//       deviceArea,
//       areaPerUnitPerMinute,
//       deviceCount: solved.plan.metrics.totalDeviceCountCeil,
//       powerDemandPerTick: solved.plan.metrics.powerDemandPerTick,
//       valuePerMinute,
//       valuePerArea: deviceArea > EPSILON ? valuePerMinute / deviceArea : Number.POSITIVE_INFINITY,
//       machineUsages: solved.plan.metrics.machineUsages,
//     });
//   }
//   return entries.sort((left, right) => right.valuePerArea - left.valuePerArea);
// }

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
  const valueByItemId = toValueMap(valuable);

  const variables: RegionLpVariable[] = [];
  const baseAreaBudget = new Map<string, number>();
  const includeWaterPurifier = options.sourceConfig.waterPurifierPolicy === "use-when-available";
  for (const base of bases) {
    variables.push(...buildRegionLpVariables(index, base.id, includeWaterPurifier));
    baseAreaBudget.set(base.id, base.placeableArea.width * base.placeableArea.height);
  }

  const shared = buildSharedLpOptions(index, options, valueByItemId, baseAreaBudget);
  // 可产判定必须先于基线目标：本区产不出的券物品不进基线，否则基线必然不可行（见 probeRegionValuableItems）。
  const { producible, gaps, valueRanking } = probeRegionValuableItems(index, valuable, options, shared);
  const baselineTargets = toRateMap(producible, options.targetPerMinute);

  const allResource = solveBaselinePlan(index, variables, {
    ...shared,
    targets: baselineTargets,
  });

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
    baseAllocations: splitByBase(index, bases, allResource.build, allResource.deviceCounts, valueByItemId),
    itemNameById,
  };
}