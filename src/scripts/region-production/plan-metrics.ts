/**
 * 区域产线建模 · 指标层（L2 输出度量）
 *
 * 把规划结果换算成可比较的工程指标：设备数、占地（格）、电力需求、价值产率、缺口、外部输入。
 * 本层只做换算，不改变规划结果。
 */

import type {
  ProductionPlanningIndex,
  ProductionPlanningResult,
} from "@/app/shell/production-planning/production-planning-model";
import { STANDARD_TICK_RATE_PER_SECOND } from "@/simulation/contracts/tick-rate";
import zhCnRegistry from "@/shared/i18n/zh-cn/registry";
import { resolveLayoutDeviceArea } from "./layout-area";

const EPSILON = 0.0001;

export function lookupRegistryText(nameKey: string): string {
  return zhCnRegistry[nameKey] ?? nameKey;
}

export interface MachineUsage {
  readonly machineId: string;
  readonly name: string;
  readonly deviceCount: number;
  readonly deviceCountCeil: number;
  readonly footprintWidth: number;
  readonly footprintHeight: number;
  /** 占地（格）：向上取整的设备数 × 单机 footprint 面积。 */
  // AI-CORRECTION 2026-09-28: 上述「单机 footprint 面积」已失效 —— 面积口径升级为布局占地
  // （本体 + EDA 通道 + 物流倍率，见 layout-area.ts），与 LP 面积约束、整数化复核同口径。
  readonly area: number;
  readonly powerDemandPerTick: number;
}

export interface FlowEntry {
  readonly itemId: string;
  readonly name: string;
  readonly perMinute: number;
}

export interface ShippedEntry extends FlowEntry {
  readonly value: number;
  readonly valuePerMinute: number;
}

export interface ProductionPlanMetrics {
  readonly machineUsages: MachineUsage[];
  readonly totalDeviceCountCeil: number;
  /** 设备本体占地（格），不含传送带 / 管道；物流占地由布局层（EDA）决定。 */
  // AI-CORRECTION 2026-09-28: 上述「设备本体占地，不含传送带 / 管道」已失效 —— 现在为布局占地
  // （本体 + EDA 通道 + 物流倍率），用于与基地可摆放面积预算比较利用率，见 layout-area.ts。
  readonly deviceArea: number;
  readonly powerDemandPerTick: number;
  readonly powerDemandPerSecond: number;
  readonly shipped: ShippedEntry[];
  readonly totalValuePerMinute: number;
  readonly externalInputs: FlowEntry[];
  readonly unresolved: FlowEntry[];
  readonly unresolvedTotalPerMinute: number;
}

export interface ShippedTarget {
  readonly itemId: string;
  readonly perMinute: number;
  readonly value: number;
}

export function computePlanMetrics(options: {
  readonly result: ProductionPlanningResult;
  readonly index: ProductionPlanningIndex;
  readonly shipped: readonly ShippedTarget[];
}): ProductionPlanMetrics {
  const counts = new Map<string, number>();
  for (const recipeTotal of options.result.recipeTotals) {
    if (recipeTotal.recipeId === null) {
      continue;
    }
    const recipe = options.index.recipeById.get(recipeTotal.recipeId);
    if (recipe === undefined) {
      continue;
    }
    counts.set(recipe.machineId, (counts.get(recipe.machineId) ?? 0) + recipeTotal.deviceCount);
  }

  const machineUsages: MachineUsage[] = [];
  let deviceArea = 0;
  let powerDemandPerTick = 0;
  let totalDeviceCountCeil = 0;

  for (const [machineId, deviceCount] of counts) {
    const entity = options.index.entityById.get(machineId);
    const footprintWidth = entity?.footprint.width ?? 0;
    const footprintHeight = entity?.footprint.height ?? 0;
    const deviceCountCeil = Math.max(0, Math.ceil(deviceCount - EPSILON));
    const area = deviceCountCeil * resolveLayoutDeviceArea(footprintWidth, footprintHeight);
    const power = deviceCount * (entity?.powerDemand ?? 0);
    machineUsages.push({
      machineId,
      name: lookupRegistryText(entity?.nameKey ?? machineId),
      deviceCount,
      deviceCountCeil,
      footprintWidth,
      footprintHeight,
      area,
      powerDemandPerTick: power,
    });
    deviceArea += area;
    powerDemandPerTick += power;
    totalDeviceCountCeil += deviceCountCeil;
  }
  machineUsages.sort((left, right) => right.area - left.area);

  const shipped: ShippedEntry[] = options.shipped.map((target) => ({
    itemId: target.itemId,
    name: resolveItemName(options.index, target.itemId),
    perMinute: target.perMinute,
    value: target.value,
    valuePerMinute: target.perMinute * target.value,
  }));
  const totalValuePerMinute = shipped.reduce((sum, entry) => sum + entry.valuePerMinute, 0);

  const externalInputs: FlowEntry[] = [];
  const unresolved: FlowEntry[] = [];
  for (const total of options.result.itemTotals) {
    if (total.producedPerMinute <= EPSILON && total.demandPerMinute > EPSILON) {
      externalInputs.push({
        itemId: total.itemId,
        name: resolveItemName(options.index, total.itemId),
        perMinute: total.demandPerMinute,
      });
    }
    if (total.unresolvedPerMinute > EPSILON) {
      unresolved.push({
        itemId: total.itemId,
        name: resolveItemName(options.index, total.itemId),
        perMinute: total.unresolvedPerMinute,
      });
    }
  }
  externalInputs.sort((left, right) => right.perMinute - left.perMinute);
  unresolved.sort((left, right) => right.perMinute - left.perMinute);

  return {
    machineUsages,
    totalDeviceCountCeil,
    deviceArea,
    powerDemandPerTick,
    powerDemandPerSecond: powerDemandPerTick * STANDARD_TICK_RATE_PER_SECOND,
    shipped,
    totalValuePerMinute,
    externalInputs,
    unresolved,
    unresolvedTotalPerMinute: options.result.unresolvedPerMinute,
  };
}

function resolveItemName(index: ProductionPlanningIndex, itemId: string): string {
  const item = index.itemById.get(itemId);
  return item === undefined ? itemId : lookupRegistryText(item.nameKey);
}