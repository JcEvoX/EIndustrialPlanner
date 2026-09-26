/**
 * 区域产线建模 · L2 线性规划模型层
 *
 * 把「地区内可用的生产配方」展成线性规划变量（1 个变量 = 1 台满速设备），
 * 并写出三类约束：物料平衡、区域自然资源上限、基地面积预算。物料平衡树表达不了多配方环，
 * 这里统一用线性规划求解，避免环被静默掩盖成缺口。
 *
 * 变量与系数约定：
 * - 变量 x_r：某候选配方的设备台数（连续，非负）；
 * - 候选输入的 perMinute 已经是「单台设备满速」的每分钟流量，因此系数直接取该值；
 * - 目标一律最大化，minimize 目标通过取负实现。
 *
 * AI-CORRECTION 2026-09-26: 采集设备（矿机 / 气矿机 / 水泵）不再作为变量参与求解。
 * 原因：用户确认采集设备放在基地之外，不占基地区域面积；其产量以「区域共享资源池上限」表达。
 * 新行为：带 `自然资源采集` tag 的配方从变量集合剔除，其产物转为带上限的外部供给（见 resolveExternalSupplyCap）。
 * 该口径与 blueprint-planner/production-network.ts 的 normalizePlannerSources 一致（那一层同样把自然采集剥离为外供来源）。
 */

import type { ProductionPlanningIndex, ProductionPlanningResult } from "@/app/shell/production-planning/production-planning-model";
import {
  maximizeLinearProgram,
  type LinearConstraint,
  type LinearProgram,
  type LinearProgramSolution,
} from "./simplex";

const EPSILON = 1e-6;
const NATURAL_RESOURCE_TAG = "自然资源";
const INFINITE_SUPPLY_TAG = "无限供应";
/** 采集类配方（矿机 / 气矿机 / 水泵）：设备放在基地之外，不占基地面积，产量即为区域资源池上限。 */
const EXTRACTION_RECIPE_TAG = "自然资源采集";

export interface RegionLpFlow {
  readonly itemId: string;
  readonly perMinute: number;
}

/** 单个 LP 变量：候选配方满速单机的净流量与工程属性。 */
export interface RegionLpVariable {
  readonly candidateId: string;
  readonly recipeId: string;
  readonly machineId: string;
  readonly machineNameKey: string;
  readonly durationSeconds: number;
  readonly deviceArea: number;
  readonly powerDemandPerTick: number;
  readonly produced: readonly RegionLpFlow[];
  readonly consumed: readonly RegionLpFlow[];
}

export interface RegionLpOptions {
  /** 可占用面积预算（格）。 */
  readonly areaBudget: number;
  /** 基线约束：物品净产出下限（每分钟）。 */
  readonly targets: ReadonlyMap<string, number>;
  /** 物品调度券价值；未登记价值的物品按 0 计。 */
  readonly valueByItemId: ReadonlyMap<string, number>;
  /** 区域自然资源外部供给上限（每分钟）；缺省表示不设上限。 */
  readonly resourceLimits: ReadonlyMap<string, number>;
  /** 允许无限外部供给的物品（如清水、酸液）。 */
  readonly infiniteItemIds: ReadonlySet<string>;
  /** 全部 `自然资源` 物品：一律由区域资源池供给，不要求基地内自平衡。 */
  readonly naturalResourceItemIds: ReadonlySet<string>;
  /** 允许直接排放/输出的物品（如外部处理污水）。 */
  readonly dumpableItemIds: ReadonlySet<string>;
  /** 优化目标：value = 价值/分钟最大；area = 基线面积最小。 */
  readonly objective: "value" | "area";
}

export interface RegionLpBuild {
  readonly program: LinearProgram;
  readonly variables: readonly RegionLpVariable[];
  readonly itemIds: readonly string[];
  /** 物品 → 物料平衡约束行下标。 */
  readonly balanceRowByItem: ReadonlyMap<string, number>;
  /** 由区域资源池供给（而非基地内生产）的物品，指标层据此标记为「外部输入」而非「缺口」。 */
  readonly externalSupplyItemIds: ReadonlySet<string>;
  /** 基线约束行下标 → 物品 id。 */
  readonly baselineItems: readonly string[];
  readonly areaRowIndex: number;
}

export interface RegionLpResult {
  readonly build: RegionLpBuild;
  readonly solution: LinearProgramSolution;
  /** 每个变量的求解取值（设备台数），与 build.variables 对齐。 */
  readonly deviceCounts: readonly number[];
}

/** 判定物品是否属于「无限供应」自然资源。 */
export function resolveInfiniteSupplyItemIds(index: ProductionPlanningIndex): Set<string> {
  const result = new Set<string>();
  for (const item of index.itemById.values()) {
    if (item.tags.includes(NATURAL_RESOURCE_TAG) && item.tags.includes(INFINITE_SUPPLY_TAG)) {
      result.add(item.id);
    }
  }
  return result;
}

/** 收集全部 `自然资源` 物品：采集设备在基地之外，这些物品一律由区域资源池供给。 */
export function resolveNaturalResourceItemIds(index: ProductionPlanningIndex): Set<string> {
  const result = new Set<string>();
  for (const item of index.itemById.values()) {
    if (item.tags.includes(NATURAL_RESOURCE_TAG)) {
      result.add(item.id);
    }
  }
  return result;
}

// AI-REMOVED 2026-09-26:
// Reason: 该判定把「自然资源」与「是否可配置上限」绑在一起，无法表达「自然资源一律外供、上限可缺省」的口径。
// Trigger: 武陵基线 LP 不可行 —— gas_inert 被拆罐回收配方顺带产出，于是被判成「必须自平衡」，外部供给记 0。
// Evidence: .temp/.trash/region-probe/diag-wuling4.mjs 定位到 item_copper_jar / item_gas_inert 链。
// Replacement: resolveNaturalResourceItemIds + resolveExternalSupplyCap 内的自然资源分支。
// Risk: Low
// Human Review: Required
//
// Original code:
// export function isConfigurableNaturalResource(index: ProductionPlanningIndex, itemId: string): boolean {
//   const item = index.itemById.get(itemId);
//   if (item === undefined) {
//     return false;
//   }
//   return item.tags.includes(NATURAL_RESOURCE_TAG) && !item.tags.includes(INFINITE_SUPPLY_TAG);
// }

/** 构造 LP 变量集合：地区索引内全部系统配方候选（剔除采集类），每项对应一台满速设备。 */
export function buildRegionLpVariables(index: ProductionPlanningIndex): RegionLpVariable[] {
  const variables: RegionLpVariable[] = [];
  for (const candidate of index.candidateById.values()) {
    if (candidate.sourceType !== "system-recipe" || candidate.recipeId === null) {
      continue;
    }
    const recipe = index.recipeById.get(candidate.recipeId);
    if (recipe === undefined || recipe.tags.includes(EXTRACTION_RECIPE_TAG)) {
      continue;
    }
    const entity = index.entityById.get(recipe.machineId);
    const footprintWidth = entity?.footprint.width ?? 0;
    const footprintHeight = entity?.footprint.height ?? 0;
    // 面积系数必须为正，否则求解器可以无成本堆设备导致目标无界。
    const deviceArea = footprintWidth > 0 && footprintHeight > 0 ? footprintWidth * footprintHeight : 1;
    const produced: RegionLpFlow[] = [];
    const consumed: RegionLpFlow[] = [];
    for (const output of candidate.outputs) {
      if (output.perMinute > EPSILON) {
        produced.push({ itemId: output.itemId, perMinute: output.perMinute });
      }
    }
    for (const input of candidate.inputs) {
      if (input.perMinute > EPSILON) {
        consumed.push({ itemId: input.itemId, perMinute: input.perMinute });
      }
    }
    variables.push({
      candidateId: candidate.id,
      recipeId: recipe.id,
      machineId: recipe.machineId,
      machineNameKey: entity?.nameKey ?? recipe.machineId,
      durationSeconds: recipe.durationSeconds,
      deviceArea,
      powerDemandPerTick: entity?.powerDemand ?? 0,
      produced,
      consumed,
    });
  }
  return variables;
}

/**
 * 组装线性规划：
 * - 物料平衡：`消耗 - 生产 <= 外部供给`；内部中间物外部供给为 0，纯外部输入不设行；
 *   `自然资源` 一律由区域资源池供给，其外部供给即上限（采集设备不在基地内，产量由区域资源池给出）；
 * - 面积预算：`Σ 面积 × 台数 <= 预算`；
 * - 基线：可生产券物品 `生产 - 消耗 >= 目标速率`。
 */
export function buildRegionLp(
  options: RegionLpOptions,
  variables: readonly RegionLpVariable[],
): RegionLpBuild {
  const variableCount = variables.length;
  const producedByVariable = new Set<string>();
  const consumedByVariable = new Set<string>();
  const itemIdSet = new Set<string>();
  for (const variable of variables) {
    for (const flow of variable.produced) {
      producedByVariable.add(flow.itemId);
      itemIdSet.add(flow.itemId);
    }
    for (const flow of variable.consumed) {
      consumedByVariable.add(flow.itemId);
      itemIdSet.add(flow.itemId);
    }
  }
  const itemIds = [...itemIdSet].sort();

  const constraints: LinearConstraint[] = [];
  const balanceRowByItem = new Map<string, number>();
  const externalSupplyItemIds = new Set<string>();

  // 1. 物料平衡行
  for (const itemId of itemIds) {
    if (!consumedByVariable.has(itemId)) {
      continue;
    }
    const externalCap = resolveExternalSupplyCap(itemId, options, producedByVariable);
    if (externalCap > 0) {
      externalSupplyItemIds.add(itemId);
    }
    if (!Number.isFinite(externalCap)) {
      continue;
    }
    const coefficients = new Array<number>(variableCount).fill(0);
    let touched = false;
    for (let column = 0; column < variableCount; column++) {
      const variable = variables[column]!;
      const consumedPerMinute = sumFlow(variable.consumed, itemId);
      const producedPerMinute = sumFlow(variable.produced, itemId);
      const coefficient = consumedPerMinute - producedPerMinute;
      if (coefficient !== 0) {
        coefficients[column] = coefficient;
        touched = true;
      }
    }
    if (!touched) {
      continue;
    }
    balanceRowByItem.set(itemId, constraints.length);
    constraints.push({ coefficients, relation: "<=", rhs: externalCap });
  }

  // 2. 面积预算行
  const areaCoefficients = variables.map((variable) => variable.deviceArea);
  const areaRowIndex = constraints.length;
  constraints.push({ coefficients: areaCoefficients, relation: "<=", rhs: options.areaBudget });

  // 3. 基线行
  const baselineItems: string[] = [];
  for (const [itemId, target] of options.targets) {
    if (target <= EPSILON) {
      continue;
    }
    const coefficients = new Array<number>(variableCount).fill(0);
    for (let column = 0; column < variableCount; column++) {
      const variable = variables[column]!;
      const net = sumFlow(variable.produced, itemId) - sumFlow(variable.consumed, itemId);
      if (net !== 0) {
        coefficients[column] = net;
      }
    }
    baselineItems.push(itemId);
    constraints.push({ coefficients, relation: ">=", rhs: target });
  }

  const objective = new Array<number>(variableCount).fill(0);
  for (let column = 0; column < variableCount; column++) {
    const variable = variables[column]!;
    if (options.objective === "area") {
      objective[column] = -variable.deviceArea;
    } else {
      let coefficient = 0;
      for (const flow of variable.produced) {
        coefficient += (options.valueByItemId.get(flow.itemId) ?? 0) * flow.perMinute;
      }
      for (const flow of variable.consumed) {
        coefficient -= (options.valueByItemId.get(flow.itemId) ?? 0) * flow.perMinute;
      }
      objective[column] = coefficient;
    }
  }

  return {
    program: { variableCount, constraints, objective },
    variables,
    itemIds,
    balanceRowByItem,
    externalSupplyItemIds,
    baselineItems,
    areaRowIndex,
  };
}

/** 求解一次区域 LP。 */
export function solveRegionLp(
  index: ProductionPlanningIndex,
  options: RegionLpOptions,
  variables: readonly RegionLpVariable[] = buildRegionLpVariables(index),
): RegionLpResult {
  const build = buildRegionLp(options, variables);
  const solution = maximizeLinearProgram(build.program);
  const deviceCounts = variables.map((_, column) => {
    const value = solution.values[column] ?? 0;
    return Math.abs(value) <= EPSILON ? 0 : value;
  });
  return { build, solution, deviceCounts };
}

/**
 * 无限供应物、可排放物、以及「无任何基地内配方产出」的物品允许无限外部供给；
 * `自然资源` 一律由区域资源池供给：登记了上限就取上限，未登记则暂不设限；
 * 其余物品上限为 0，必须由基地内生产自平衡。
 */
function resolveExternalSupplyCap(
  itemId: string,
  options: RegionLpOptions,
  producedByVariable: ReadonlySet<string>,
): number {
  if (options.infiniteItemIds.has(itemId) || options.dumpableItemIds.has(itemId)) {
    return Number.POSITIVE_INFINITY;
  }
  if (options.naturalResourceItemIds.has(itemId)) {
    const limit = options.resourceLimits.get(itemId);
    return limit !== undefined && Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
  }
  if (!producedByVariable.has(itemId)) {
    return Number.POSITIVE_INFINITY;
  }
  return 0;
}

function sumFlow(flows: readonly RegionLpFlow[], itemId: string): number {
  let total = 0;
  for (const flow of flows) {
    if (flow.itemId === itemId) {
      total += flow.perMinute;
    }
  }
  return total;
}

/** 把 LP 解折算成生产规划结果，供既有指标层复用。 */
export function toProductionPlanningResult(
  build: RegionLpBuild,
  deviceCounts: readonly number[],
): ProductionPlanningResult {
  const recipeTotals: ProductionPlanningResult["recipeTotals"] = [];
  const producedByItem = new Map<string, number>();
  const consumedByItem = new Map<string, number>();

  for (let column = 0; column < build.variables.length; column++) {
    const deviceCount = deviceCounts[column] ?? 0;
    if (deviceCount <= EPSILON) {
      continue;
    }
    const variable = build.variables[column]!;
    recipeTotals.push({
      candidateId: variable.candidateId,
      candidateSourceType: "system-recipe",
      module: null,
      recipeId: variable.recipeId,
      durationSeconds: variable.durationSeconds,
      cyclesPerMinute: deviceCount * (60 / Math.max(variable.durationSeconds, EPSILON)),
      deviceCount,
      inputs: variable.consumed.map((flow) => ({
        id: `${variable.candidateId}:input:${flow.itemId}`,
        itemId: flow.itemId,
        perMinute: flow.perMinute * deviceCount,
      })),
      deviceMinimumConsumptionInputs: [],
      outputs: variable.produced.map((flow) => ({
        id: `${variable.candidateId}:output:${flow.itemId}`,
        itemId: flow.itemId,
        perMinute: flow.perMinute * deviceCount,
      })),
    });
    for (const flow of variable.produced) {
      producedByItem.set(flow.itemId, (producedByItem.get(flow.itemId) ?? 0) + flow.perMinute * deviceCount);
    }
    for (const flow of variable.consumed) {
      consumedByItem.set(flow.itemId, (consumedByItem.get(flow.itemId) ?? 0) + flow.perMinute * deviceCount);
    }
  }

  const itemTotals: ProductionPlanningResult["itemTotals"] = [];
  for (const itemId of build.itemIds) {
    const producedPerMinute = producedByItem.get(itemId) ?? 0;
    const demandPerMinute = consumedByItem.get(itemId) ?? 0;
    if (producedPerMinute <= EPSILON && demandPerMinute <= EPSILON) {
      continue;
    }
    // 由区域资源池供给的物品（自然资源等）属于外部输入，其缺口不能记成「未满足需求」。
    const externallySupplied = build.externalSupplyItemIds.has(itemId);
    itemTotals.push({
      itemId,
      demandPerMinute,
      suppliedPerMinute: producedPerMinute,
      producedPerMinute,
      unresolvedPerMinute: externallySupplied ? 0 : Math.max(0, demandPerMinute - producedPerMinute),
      isByproduct: producedPerMinute > EPSILON && demandPerMinute <= EPSILON,
    });
  }

  const unresolvedPerMinute = itemTotals.reduce((sum, total) => sum + total.unresolvedPerMinute, 0);

  return {
    roots: [],
    itemTotals,
    recipeTotals,
    overflowItems: [],
    unresolvedPerMinute,
    byproductItemIds: new Set(itemTotals.filter((total) => total.isByproduct).map((total) => total.itemId)),
  };
}