/**
 * 区域产线建模 · 报告层
 *
 * 把 analyzeRegion 的结果转成可序列化 DTO 与 Markdown 摘要；不参与求解。
 * AI-CORRECTION 2026-09-26: 报告单位由「单个基地」升级为「区域」，并新增每个基地的分摊结果。
 * 原因：求解已改为区域级统一求解，单个基地只是区域解的一个分摊切面。
 */

import type { RegionAnalysis, ValueEfficiencyEntry } from "./region-plan";
import { lookupRegistryText } from "./plan-metrics";
import type { ProductionPlanMetrics } from "./plan-metrics";

export interface FlowReport {
  readonly itemId: string;
  readonly name: string;
  readonly perMinute: number;
}

export interface ShippedReport extends FlowReport {
  readonly value: number;
  readonly valuePerMinute: number;
}

export interface MachineReport {
  readonly machineId: string;
  readonly name: string;
  readonly deviceCount: number;
  readonly deviceCountCeil: number;
  readonly area: number;
  readonly powerDemandPerTick: number;
}

export interface PlanReport {
  readonly deviceCount: number;
  readonly deviceArea: number;
  readonly powerDemandPerTick: number;
  readonly powerDemandPerSecond: number;
  readonly valuePerMinute: number;
  readonly shipped: ShippedReport[];
  readonly machines: MachineReport[];
  readonly externalInputs: FlowReport[];
  readonly unresolved: FlowReport[];
  readonly unresolvedTotalPerMinute: number;
}

/** 区域资源池条目：perMinute 为 null 表示无限供给。 */
export interface ResourcePoolEntryReport {
  readonly itemId: string;
  readonly name: string;
  readonly perMinute: number | null;
}

export interface BaseSummaryReport {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly area: number;
  readonly areaBudget: number;
}

export interface BaseAllocationReport {
  readonly base: BaseSummaryReport;
  readonly plan: PlanReport;
  readonly areaUtilization: number;
}

export interface RegionReport {
  readonly region: string;
  readonly resourcePreset: { readonly id: string; readonly name: string } | null;
  readonly resourcePool: readonly ResourcePoolEntryReport[];
  readonly options: {
    readonly targetPerMinute: number;
  };
  readonly bases: readonly BaseSummaryReport[];
  readonly valuable: readonly ({ itemId: string; name: string; value: number } & { producible: boolean })[];
  readonly gaps: readonly { readonly itemId: string; readonly name: string; readonly value: number }[];
  readonly allResource: PlanReport & { readonly areaUtilization: number };
  readonly valueRanking: readonly ValueEfficiencyEntry[];
  readonly maxValue: PlanReport & {
    readonly budget: number;
    readonly baselineArea: number;
    readonly remainingArea: number;
    readonly areaUtilization: number;
    readonly overflow: RegionAnalysis["maxValue"]["overflow"];
  };
  readonly allocations: readonly BaseAllocationReport[];
}

function toPlanReport(metrics: ProductionPlanMetrics): PlanReport {
  return {
    deviceCount: metrics.totalDeviceCountCeil,
    deviceArea: metrics.deviceArea,
    powerDemandPerTick: metrics.powerDemandPerTick,
    powerDemandPerSecond: metrics.powerDemandPerSecond,
    valuePerMinute: metrics.totalValuePerMinute,
    shipped: metrics.shipped.map((entry) => ({
      itemId: entry.itemId,
      name: entry.name,
      perMinute: entry.perMinute,
      value: entry.value,
      valuePerMinute: entry.valuePerMinute,
    })),
    machines: metrics.machineUsages.map((usage) => ({
      machineId: usage.machineId,
      name: usage.name,
      deviceCount: usage.deviceCount,
      deviceCountCeil: usage.deviceCountCeil,
      area: usage.area,
      powerDemandPerTick: usage.powerDemandPerTick,
    })),
    externalInputs: metrics.externalInputs.map((entry) => ({ ...entry })),
    unresolved: metrics.unresolved.map((entry) => ({ ...entry })),
    unresolvedTotalPerMinute: metrics.unresolvedTotalPerMinute,
  };
}

function toBaseSummary(
  base: RegionAnalysis["bases"][number],
  areaBudget: number,
): BaseSummaryReport {
  return {
    id: base.id,
    name: base.name,
    width: base.placeableArea.width,
    height: base.placeableArea.height,
    area: base.placeableArea.width * base.placeableArea.height,
    areaBudget,
  };
}

export function buildRegionReport(analysis: RegionAnalysis): RegionReport {
  const { options, valuable, producible, gaps, allocations, resourceLimits } = analysis;
  const producibleIds = new Set(producible.map((item) => item.itemId));
  const nameOf = (itemId: string): string => analysis.itemNameById.get(itemId) ?? itemId;

  const budgetByBaseId = new Map(allocations.map((entry) => [entry.base.id, entry.areaBudget]));
  const bases = analysis.bases.map((base) =>
    toBaseSummary(base, budgetByBaseId.get(base.id) ?? base.placeableArea.width * base.placeableArea.height),
  );

  const resourcePool: ResourcePoolEntryReport[] = [];
  if (resourceLimits !== null) {
    for (const [itemId, perMinute] of resourceLimits.limits) {
      resourcePool.push({ itemId, name: nameOf(itemId), perMinute });
    }
    for (const itemId of resourceLimits.infiniteItemIds) {
      resourcePool.push({ itemId, name: nameOf(itemId), perMinute: null });
    }
  }

  return {
    region: analysis.regionTag,
    resourcePreset: resourceLimits === null
      ? null
      : { id: resourceLimits.presetId, name: resourceLimits.presetName },
    resourcePool,
    options: { targetPerMinute: options.targetPerMinute },
    bases,
    valuable: valuable.map((item) => ({
      itemId: item.itemId,
      name: lookupRegistryText(item.nameKey),
      value: item.value,
      producible: producibleIds.has(item.itemId),
    })),
    gaps: gaps.map((item) => ({
      itemId: item.itemId,
      name: lookupRegistryText(item.nameKey),
      value: item.value,
    })),
    allResource: {
      ...toPlanReport(analysis.allResource.metrics),
      areaUtilization: analysis.maxValue.budget > 0
        ? analysis.allResource.metrics.deviceArea / analysis.maxValue.budget
        : 0,
    },
    valueRanking: analysis.valueRanking,
    maxValue: {
      ...toPlanReport(analysis.maxValue.metrics),
      budget: analysis.maxValue.budget,
      baselineArea: analysis.maxValue.baselineArea,
      remainingArea: analysis.maxValue.remainingArea,
      areaUtilization: analysis.maxValue.areaUtilization,
      overflow: analysis.maxValue.overflow,
    },
    allocations: allocations.map((entry) => ({
      base: toBaseSummary(entry.base, entry.areaBudget),
      plan: toPlanReport(entry.plan.metrics),
      areaUtilization: entry.areaBudget > 0 ? entry.plan.metrics.deviceArea / entry.areaBudget : 0,
    })),
  };
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) {
    return "∞";
  }
  return value.toFixed(digits);
}

function formatPlanLines(plan: PlanReport, areaBudget: number): string[] {
  const utilization = areaBudget > 0 ? formatNumber((plan.deviceArea / areaBudget) * 100, 1) : "0.0";
  const lines = [
    `- 设备：${plan.deviceCount} 台，占地 ${plan.deviceArea} 格（利用率 ${utilization}%），电力 ${formatNumber(plan.powerDemandPerTick)}/tick`,
    `- 价值：${formatNumber(plan.valuePerMinute)} /分钟`,
    `- 已产券物品：${plan.shipped
      .map((entry) => `${entry.name}×${formatNumber(entry.perMinute)}/min(价值${entry.value})`)
      .join("，") || "无"}`,
  ];
  if (plan.machines.length > 0) {
    const nameCounts = new Map<string, number>();
    for (const machine of plan.machines) {
      nameCounts.set(machine.name, (nameCounts.get(machine.name) ?? 0) + 1);
    }
    lines.push(
      `- 设备构成：${plan.machines
        .slice(0, 12)
        .map((machine) => {
          const duplicated = (nameCounts.get(machine.name) ?? 0) > 1;
          const label = duplicated ? `${machine.name}(${machine.machineId})` : machine.name;
          return `${label}×${formatNumber(machine.deviceCount)}`;
        })
        .join("，")}`,
    );
  }
  if (plan.externalInputs.length > 0) {
    lines.push(
      `- 外部输入：${plan.externalInputs
        .map((entry) => `${entry.name} ${formatNumber(entry.perMinute)}/min`)
        .join("，")}`,
    );
  }
  if (plan.unresolved.length > 0) {
    lines.push(
      `- 未满足需求：${plan.unresolved
        .map((entry) => `${entry.name} ${formatNumber(entry.perMinute)}/min`)
        .join("，")}`,
    );
  }
  return lines;
}

export function renderRegionMarkdown(report: RegionReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.region} · 区域产线建模`);
  lines.push("");
  lines.push(
    `基地 ${report.bases.length} 个，合计可摆放面积 ${report.maxValue.budget} 格；`
    + `基础目标速率 ${report.options.targetPerMinute}/min。`,
  );
  if (report.resourcePreset === null) {
    lines.push("");
    lines.push("> 未找到该地区的版本资源预设，区域资源池按「不设上限」处理，结果偏乐观。");
  }
  lines.push("");

  if (report.resourcePool.length > 0) {
    lines.push("## 区域资源池（按大区域共享）");
    lines.push("");
    lines.push("| 资源 | 上限/分钟 |");
    lines.push("| --- | ---: |");
    for (const entry of report.resourcePool) {
      lines.push(`| ${entry.name} | ${entry.perMinute === null ? "∞" : formatNumber(entry.perMinute)} |`);
    }
    lines.push("");
  }

  lines.push("## 基地");
  lines.push("");
  lines.push("| 基地 | 尺寸 | 面积 | 可摆放预算 |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const base of report.bases) {
    lines.push(`| ${base.name}（${base.id}） | ${base.width}×${base.height} | ${base.area} | ${base.areaBudget} |`);
  }
  lines.push("");
  lines.push(
    `- 券价值物品 ${report.valuable.length} 种，本地区可产 ${report.valuable.filter((item) => item.producible).length} 种，`
    + `缺口 ${report.gaps.length} 种`,
  );

  lines.push("");
  lines.push("## 全资源基础计划（保证不缺料，区域级）");
  lines.push(...formatPlanLines(report.allResource, report.maxValue.budget));
  lines.push("");
  lines.push("## 单位面积价值排名（TOP 10）");
  lines.push("");
  lines.push("| 物品 | 价值 | 单机速率/min | 占地/格 | 价值/分钟/格 |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const entry of report.valueRanking.slice(0, 10)) {
    lines.push(
      `| ${entry.name} | ${entry.value} | ${formatNumber(entry.perMinute)} | ${entry.deviceArea} | `
      + `${formatNumber(entry.valuePerArea)} |`,
    );
  }
  lines.push("");
  lines.push("## 最高价值计划（区域级，基础计划 + 剩余面积追加）");
  if (report.maxValue.overflow === null) {
    lines.push("- 无剩余面积可用于追加高价值产线（基础计划已占满或超出预算）。");
  } else {
    lines.push(
      `- 追加产线：${report.maxValue.overflow.name} × ${formatNumber(report.maxValue.overflow.perMinute)}/min`
      + `（原价值 ${report.maxValue.overflow.value}）`,
    );
  }
  lines.push(...formatPlanLines(report.maxValue, report.maxValue.budget));

  lines.push("");
  lines.push("## 按基地分摊");
  lines.push("");
  lines.push("| 基地 | 设备 | 占地 | 利用率 | 电力/tick |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const entry of report.allocations) {
    lines.push(
      `| ${entry.base.name} | ${entry.plan.deviceCount} | ${entry.plan.deviceArea} | `
      + `${formatNumber(entry.areaUtilization * 100, 1)}% | ${formatNumber(entry.plan.powerDemandPerTick)} |`,
    );
  }
  for (const entry of report.allocations) {
    lines.push("");
    lines.push(`### ${entry.base.name}（${entry.base.id}）`);
    lines.push(...formatPlanLines(entry.plan, entry.base.areaBudget));
  }

  if (report.gaps.length > 0) {
    lines.push("");
    lines.push("## 本地区不可产出的券价值物品（需跨区或外部供给）");
    for (const gap of report.gaps) {
      lines.push(`- ${gap.name}（价值 ${gap.value}，${gap.itemId}）`);
    }
  }
  lines.push("");
  return lines.join("\n");
}