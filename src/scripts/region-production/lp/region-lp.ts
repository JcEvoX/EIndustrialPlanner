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
  /** 变量归属基地：同一配方在不同基地是不同变量，因为面积预算按基地独立核算。 */
  readonly baseId: string;
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
  // AI-REMOVED 2026-09-26:
  // Reason: 单值面积预算无法表达「资源池按区域共享、面积按基地独立」的多基地统一求解。
  // Trigger: 用户确认资源池按大区域共享，需「区域级统一求解后分摊」。
  // Evidence: 版本资源预设的 regionTag 是区域级；基地级各自求解会按基地数量重复放大资源上限。
  // Replacement: 下方 baseAreaBudget。
  // Risk: Low
  // Human Review: Required
  //
  // Original code:
  // /** 可占用面积预算（格）。 */
  // readonly areaBudget: number;
  /** 每个基地的可占用面积预算（格）；缺该基地条目时求解直接报错，不静默按 0 处理。 */
  readonly baseAreaBudget: ReadonlyMap<string, number>;
  /** 基线约束：物品净产出下限（每分钟）。 */
  readonly targets: ReadonlyMap<string, number>;
  /** 物品调度券价值（全量）；未登记价值的物品按 0 计。只用于展示口径（如 shipped），不作为目标系数。 */
  readonly valueByItemId: ReadonlyMap<string, number>;
  /**
   * 目标函数用的价值系数：只包含达到「高价值门槛」的物品，门槛以下一律为 0。
   *
   * AI-CORRECTION 2026-09-26: 原实现把 valueByItemId 全量喂给目标函数，任何单位面积为正的产线
   * 都值得建满，有限资源用尽后剩余面积必然被「低价值 + 无限原料」的产线填充（武陵因此多产
   * 2239/min 的息壤）。新行为：低价值物品不参与最大化，剩余面积宁可留空也不堆低价值产线；
   * 低价值物品仍受基线约束（每种可生产物品 >= 目标速率），也仍可作高价值产线的中间物/副产物产出。
   */
  readonly objectiveValueByItemId: ReadonlyMap<string, number>;
  /** 区域自然资源外部供给上限（每分钟）；缺省表示不设上限。 */
  readonly resourceLimits: ReadonlyMap<string, number>;
  /** 允许无限外部供给的物品（如清水、酸液）。 */
  readonly infiniteItemIds: ReadonlySet<string>;
  /** 全部 `自然资源` 物品：一律由区域资源池供给，不要求基地内自平衡。 */
  readonly naturalResourceItemIds: ReadonlySet<string>;
  /**
   * 可排放副产物（如外部处理污水）：只允许「产出过剩直接排掉」，不允许净消耗。
   * 约束形态是 `消耗 - 生产 <= 0`，即基线必须由本地区配方产出。
   *
   * AI-CORRECTION 2026-09-26: 原语义为「无限外部供给」（平衡行直接跳过），
   * 该口径允许从区域外凭空引入污水，净水节点因此把无限污水白转成壤晶废液，
   * 武陵重息壤被放大到 620/min（污水外部输入合计 7 万/min）。污水并非 `自然资源`
   * （registry 内只有水泵/集气泵/矿机带 `自然资源采集` tag），必须本地区自产。
   * 新行为：把「可排放」收敛为「净消耗 <= 0 的排放口」。
   */
  readonly dumpableItemIds: ReadonlySet<string>;
  /** 优化目标：value = 价值/分钟最大；balance = 最小基地利用率最大（均衡分摊）；area = 基线面积最小。 */
  readonly objective: "value" | "area" | "balance";
  /**
   * 净值下界（调度券价值/分钟）：给定后追加 `Σ 净值 × 台数 >= valueFloor`。
   * 供词典序求解使用 —— 先求价值最优，再用该下界锁定价值、把目标切换为面积最小，
   * 从而在同价值解中取面积最小者，消除零价值设备（如净水节点）在退化解里的多重最优伪影。
   */
  readonly valueFloor?: number;
  /**
   * 面积上界（格，全区域合计）：给定后追加 `Σ 面积 × 台数 <= areaFloor`。
   * 供词典序求解使用 —— 先锁定价值与面积最优，再在该解集内求均衡，
   * 从而保证「均衡」不会通过新增低价值设备来提高最小利用率。
   */
  readonly areaFloor?: number;
  /**
   * 最小基地利用率下界：给定后追加 `t >= balanceFloor`（t 为均衡辅助变量，见 buildRegionLp）。
   * 供词典序求解使用 —— 先求价值最优、再求均衡度最优，最后在该均衡度下最小化面积。
   */
  readonly balanceFloor?: number;
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
  /** 基地 id → 该基地面积预算约束行下标。 */
  readonly areaRowByBaseId: ReadonlyMap<string, number>;
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

/**
 * 构造某基地的 LP 变量集合：地区索引内全部系统配方候选（剔除采集类），每项对应一台满速设备。
 * 同一地区内多个基地各调用一次，变量以 baseId 区分，从而在区域级 LP 内联立。
 */
export function buildRegionLpVariables(
  index: ProductionPlanningIndex,
  baseId: string,
): RegionLpVariable[] {
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
      baseId,
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
 *   该行在区域级共享：同一地区多个基地共同消耗同一份资源上限；
 * - 面积预算：每基地一行 `Σ 该基地 面积 × 台数 <= 该基地预算`；
 * - 基线：可生产券物品 `生产 - 消耗 >= 目标速率`（区域级共享，不要求每个基地都产）；
 * - 净值下界（可选）：`Σ 目标净值 × 台数 >= valueFloor`，用于锁定价值后再最小化面积；
 * - 面积上界（可选）：`Σ 面积 × 台数 <= areaFloor`，用于锁定面积最优后再求均衡，
 *   使均衡不会靠新增低价值设备来提高最小利用率；
 * - 均衡行（可选）：每基地一行 `Σ 该基地 面积 × 台数 >= 预算 × t`，等价于 `t <= 该基地利用率`；
 *   t 是追加的辅助变量，目标为 balance 时最大化 t，即「最大化最小基地利用率」。该行只约束
 *   面积在基地间的分布，不改变总价值最优性 —— 因此可在价值锁定后作为次目标使用。
 *
 * 列布局：[原始变量][均衡辅助变量 t（可选）]；t 列不影响 variables 与 deviceCounts 的对齐。
 */
export function buildRegionLp(
  options: RegionLpOptions,
  variables: readonly RegionLpVariable[],
): RegionLpBuild {
  const variableCount = variables.length;
  // t 列仅在需要均衡时追加：要么以均衡为目标，要么需要施加均衡度下界。
  const usesBalanceColumn = options.objective === "balance" || options.balanceFloor !== undefined;
  const balanceColumn = variableCount;
  const totalColumns = variableCount + (usesBalanceColumn ? 1 : 0);
  // AI-REMOVED 2026-09-26:
  // Reason: producedByVariable 的唯一用途是「区域内无配方产出 → 无限外部供给」兜底，该兜底已按 fail-closed 移除。
  // Trigger: 用户确认 fail-closed 口径（区域内不可生产且未声明为资源池/无限供应的物品一律按 0）。
  // Evidence: 全文件仅 resolveExternalSupplyCap 读取该集合；原木（手采资源）因此被当成无限外供。
  // Replacement: None；生产侧物品仍由下方 itemIdSet 维护（物料平衡行与指标层只依赖 itemIds）。
  // Risk: Low
  // Human Review: Required
  //
  // Original code:
  // const producedByVariable = new Set<string>();
  const consumedByVariable = new Set<string>();
  const itemIdSet = new Set<string>();
  for (const variable of variables) {
    for (const flow of variable.produced) {
      // AI-REMOVED 2026-09-26: 随 producedByVariable 一并移除（已无消费方）；物品仍进入 itemIdSet。
      // producedByVariable.add(flow.itemId);
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
    // 可排放副产物（污水等）即使上限为 0 也不是「缺口」，需计入外部处置口径。
    const isDumpable = options.dumpableItemIds.has(itemId);
    const externalCap = resolveExternalSupplyCap(itemId, options);
    if (externalCap > 0 || isDumpable) {
      externalSupplyItemIds.add(itemId);
    }
    if (!Number.isFinite(externalCap)) {
      continue;
    }
    const coefficients = new Array<number>(totalColumns).fill(0);
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

  // 2. 面积预算行：每个基地一行。资源上限区域共享，面积预算必须按基地独立核算。
  const areaRowByBaseId = new Map<string, number>();
  const baseIds = [...new Set(variables.map((variable) => variable.baseId))].sort();
  for (const baseId of baseIds) {
    const budget = options.baseAreaBudget.get(baseId);
    if (budget === undefined) {
      throw new Error(`缺少基地面积预算：${baseId}`);
    }
    const coefficients = new Array<number>(totalColumns).fill(0);
    for (let column = 0; column < variableCount; column++) {
      const variable = variables[column]!;
      if (variable.baseId === baseId) {
        coefficients[column] = variable.deviceArea;
      }
    }
    areaRowByBaseId.set(baseId, constraints.length);
    constraints.push({ coefficients, relation: "<=", rhs: budget });
  }

  // 3. 基线行
  const baselineItems: string[] = [];
  for (const [itemId, target] of options.targets) {
    if (target <= EPSILON) {
      continue;
    }
    const coefficients = new Array<number>(totalColumns).fill(0);
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

  // 4. 净值系数：两种目标都要用，先算一次；只累加达到高价值门槛的物品（见 objectiveValueByItemId）。
  const valueCoefficients = new Array<number>(totalColumns).fill(0);
  for (let column = 0; column < variableCount; column++) {
    const variable = variables[column]!;
    let coefficient = 0;
    for (const flow of variable.produced) {
      coefficient += (options.objectiveValueByItemId.get(flow.itemId) ?? 0) * flow.perMinute;
    }
    for (const flow of variable.consumed) {
      coefficient -= (options.objectiveValueByItemId.get(flow.itemId) ?? 0) * flow.perMinute;
    }
    valueCoefficients[column] = coefficient;
  }
  if (options.valueFloor !== undefined) {
    constraints.push({ coefficients: valueCoefficients, relation: ">=", rhs: options.valueFloor });
  }

  // 面积上界：锁定面积最优后再求均衡，避免均衡靠新增设备提高最小利用率。
  if (options.areaFloor !== undefined) {
    const coefficients = new Array<number>(totalColumns).fill(0);
    for (let column = 0; column < variableCount; column++) {
      coefficients[column] = variables[column]!.deviceArea;
    }
    constraints.push({ coefficients, relation: "<=", rhs: options.areaFloor });
  }

  // 5. 均衡行：`t <= 该基地利用率` 写作 `Σ 面积 × 台数 - 预算 × t >= 0`（左侧取负后为 <= 形态）。
  if (usesBalanceColumn) {
    for (const baseId of baseIds) {
      const budget = options.baseAreaBudget.get(baseId);
      if (budget === undefined) {
        throw new Error(`缺少基地面积预算：${baseId}`);
      }
      const coefficients = new Array<number>(totalColumns).fill(0);
      for (let column = 0; column < variableCount; column++) {
        const variable = variables[column]!;
        if (variable.baseId === baseId) {
          coefficients[column] = -variable.deviceArea;
        }
      }
      coefficients[balanceColumn] = budget;
      constraints.push({ coefficients, relation: "<=", rhs: 0 });
    }
    if (options.balanceFloor !== undefined) {
      const coefficients = new Array<number>(totalColumns).fill(0);
      coefficients[balanceColumn] = 1;
      constraints.push({ coefficients, relation: ">=", rhs: options.balanceFloor });
    }
  }

  const objective = new Array<number>(totalColumns).fill(0);
  if (options.objective === "balance") {
    objective[balanceColumn] = 1;
  } else if (options.objective === "area") {
    for (let column = 0; column < variableCount; column++) {
      objective[column] = -variables[column]!.deviceArea;
    }
  } else {
    for (let column = 0; column < variableCount; column++) {
      objective[column] = valueCoefficients[column]!;
    }
  }

  return {
    program: { variableCount: totalColumns, constraints, objective },
    variables,
    itemIds,
    balanceRowByItem,
    externalSupplyItemIds,
    baselineItems,
    areaRowByBaseId,
  };
}

/** 求解一次区域 LP。variables 由调用方按参与基地展开（见 buildRegionLpVariables）。 */
export function solveRegionLp(
  options: RegionLpOptions,
  variables: readonly RegionLpVariable[],
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
 * 无限供应物、可排放副产物、以及「无任何基地内配方产出」的物品按外部来源处理；
 * `自然资源` 一律由区域资源池供给：登记了上限就取上限，未登记则暂不设限；
 * 其余物品上限为 0，必须由基地内生产自平衡。
 *
 * AI-CORRECTION 2026-09-26: 可排放物不再返回 `Infinity`（旧行为等价于「无限外部供给」），
 * 而是返回 0 —— 只允许产出过剩排放，不允许净消耗。理由见 RegionLpOptions.dumpableItemIds。
 *
 * AI-CORRECTION 2026-09-26: 首句「无任何基地内配方产出的物品按外部来源处理」已失效。
 * 原因：该分支（原 `!producedByVariable.has(itemId) → Infinity`）等价于把区域内不可生产的物品
 * 一律当成无限外供，原木（手采资源，AKEData 区域数据无产量）因此被无限供给。
 * 新行为：fail-closed —— 未声明为资源池 / 无限供应 / 可排放的消耗项一律返回 0，
 * 必须由区域内配方产出，否则该物品在求解中不可用。用户已确认该口径。
 *
 * AI-CORRECTION 2026-09-26: 第二句「未登记则暂不设限」已失效。
 * `自然资源` 未在预设登记上限时同样按 0（同属 fail-closed 口径），不再给出无限供给。
 */
function resolveExternalSupplyCap(
  itemId: string,
  options: RegionLpOptions,
): number {
  if (options.infiniteItemIds.has(itemId)) {
    return Number.POSITIVE_INFINITY;
  }
  if (options.dumpableItemIds.has(itemId)) {
    return 0;
  }
  if (options.naturalResourceItemIds.has(itemId)) {
    const limit = options.resourceLimits.get(itemId);
    // AI-CORRECTION 2026-09-26: 原实现「未登记上限 → 不设限」为反向兜底，与用户确认的
    // fail-closed 口径冲突（`自然资源` 属于「区域内不可生产」，未声明为资源池即按 0）。
    // 原因：预设漏登记某项自然资源时，该分支会静默给出无限供给，掩盖数据缺口。
    // 新行为：自然资源未登记上限时返回 0，缺口在报告中显式暴露；登记了上限仍取上限。
    // 风险：预设漏登记会从「静默无限」变为「计划不可行/缺口」，属预期的数据校验信号。
    return limit !== undefined && Number.isFinite(limit) ? limit : 0;
  }
  // AI-REMOVED 2026-09-26:
  // Reason: 「无基地内配方产出 → 无限外部供给」兜底与区域资源上限口径冲突（原木被无限外供）。
  // Trigger: 用户确认 fail-closed：区域内不可生产且未声明为资源池/无限供应的物品一律按 0。
  // Evidence: 全文件仅本函数读取 producedByVariable；AKEData 区域数据中没有 item_plant_tundra_wood。
  // Replacement: 下方 `return 0`（严格闭口径）。
  // Risk: Low —— 若后续新增需外供的中间物，必须显式登记到资源预设或无限供应集合，否则会被判为缺口。
  // Human Review: Required
  //
  // Original code:
  // if (!producedByVariable.has(itemId)) {
  //   return Number.POSITIVE_INFINITY;
  // }
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

/**
 * 把 LP 解折算成生产规划结果，供既有指标层复用。
 * 传入变量子集即可得到「该基地分摊结果」：区域级传全部变量，基地级传各自变量。
 *
 * mode 决定缺口口径：
 * - `region`：只有区域资源池供给的物品不计缺口；
 * - `base`：基地是区域的一部分，跨基地流转对该基地同样是外部输入，因此净进口一律不计缺口。
 */
export function toProductionPlanningResult(
  variables: readonly RegionLpVariable[],
  deviceCounts: readonly number[],
  itemIds: readonly string[],
  externalSupplyItemIds: ReadonlySet<string>,
  mode: "region" | "base" = "region",
): ProductionPlanningResult {
  const recipeTotals: ProductionPlanningResult["recipeTotals"] = [];
  const producedByItem = new Map<string, number>();
  const consumedByItem = new Map<string, number>();

  for (let column = 0; column < variables.length; column++) {
    const deviceCount = deviceCounts[column] ?? 0;
    if (deviceCount <= EPSILON) {
      continue;
    }
    const variable = variables[column]!;
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
  for (const itemId of itemIds) {
    const producedPerMinute = producedByItem.get(itemId) ?? 0;
    const demandPerMinute = consumedByItem.get(itemId) ?? 0;
    if (producedPerMinute <= EPSILON && demandPerMinute <= EPSILON) {
      continue;
    }
    // 由区域资源池供给的物品（自然资源等）属于外部输入，其缺口不能记成「未满足需求」；
    // 基地口径下跨基地净进口同样由区域其他基地补足，也不算该基地的缺口。
    const externallySupplied = externalSupplyItemIds.has(itemId)
      || (mode === "base" && demandPerMinute > producedPerMinute + EPSILON);
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