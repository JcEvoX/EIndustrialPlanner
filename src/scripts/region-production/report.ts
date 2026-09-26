/**
 * 区域产线建模 · 报告层
 *
 * 把 analyzeBase 的结果转成可序列化 DTO 与 Markdown 摘要；不参与求解。
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

export interface RegionReport {
  readonly base: {
    readonly id: string;
    readonly name: string;
    readonly region: string;
    readonly width: number;
    readonly height: number;
    readonly area: number;
  };
  readonly options: {
    readonly targetPerMinute: number;
    readonly areaBudget: number;
  };
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

export function buildRegionReport(analysis: RegionAnalysis): RegionReport {
  const { base, options, valuable, producible, gaps } = analysis;
  const producibleIds = new Set(producible.map((item) => item.itemId));
  const area = base.placeableArea.width * base.placeableArea.height;

  return {
    base: {
      id: base.id,
      name: base.name,
      region: base.tag,
      width: base.placeableArea.width,
      height: base.placeableArea.height,
      area,
    },
    options: { targetPerMinute: options.targetPerMinute, areaBudget: options.areaBudget },
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
      areaUtilization: options.areaBudget > 0 ? analysis.allResource.metrics.deviceArea / options.areaBudget : 0,
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
  lines.push(`# ${report.base.region} · ${report.base.name}（${report.base.id}）`);
  lines.push("");
  lines.push(
    `基地面积 ${report.base.width}×${report.base.height} = ${report.base.area} 格；`
    + `可摆放面积预算 ${report.options.areaBudget} 格；基础目标速率 ${report.options.targetPerMinute}/min。`,
  );
  lines.push("");
  lines.push(
    `- 券价值物品 ${report.valuable.length} 种，本地区可产 ${report.valuable.filter((item) => item.producible).length} 种，`
    + `缺口 ${report.gaps.length} 种`,
  );
  lines.push("");
  lines.push("## 全资源基础计划（保证不缺料）");
  lines.push(...formatPlanLines(report.allResource, report.options.areaBudget));
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
  lines.push("## 最高单位面积价值计划（基础计划 + 剩余面积追加）");
  if (report.maxValue.overflow === null) {
    lines.push("- 无剩余面积可用于追加高价值产线（基础计划已占满或超出预算）。");
  } else {
    lines.push(
      `- 追加产线：${report.maxValue.overflow.name} × ${formatNumber(report.maxValue.overflow.perMinute)}/min`
      + `（原价值 ${report.maxValue.overflow.value}）`,
    );
  }
  lines.push(...formatPlanLines(report.maxValue, report.options.areaBudget));
  lines.push("");
  if (report.gaps.length > 0) {
    lines.push("## 本地区不可产出的券价值物品（需跨区或外部供给）");
    for (const gap of report.gaps) {
      lines.push(`- ${gap.name}（价值 ${gap.value}，${gap.itemId}）`);
    }
    lines.push("");
  }
  return lines.join("\n");
}