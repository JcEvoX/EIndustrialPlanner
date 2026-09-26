// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import {
  analyzeRegion,
  createDefaultRegionProductionOptions,
  DEFAULT_HIGH_VALUE_THRESHOLD,
  type RegionAnalysis,
  type RegionProductionOptions,
} from "@/scripts/region-production/region-plan";
import {
  solveRegionLp,
  type RegionLpOptions,
  type RegionLpVariable,
} from "@/scripts/region-production/lp/region-lp";
import {
  loadRegionResourcePresets,
  selectRegionResourceLimits,
} from "@/scripts/region-production/region-resources";
import { resolveRealBases } from "@/scripts/region-production/region-scope";

/** 值 1 的低价值券物品（息壤 / 分离芯 / 赤铜零件），用于验证门槛口径。 */
const LOW_VALUE_ITEM_IDS = new Set([
  "item_xiranite_powder",
  "item_filter_core",
  "item_copper_cmpt",
]);

async function analyze(
  regionTag: string,
  overrides: Partial<RegionProductionOptions> = {},
): Promise<RegionAnalysis> {
  const registry = createRegistryContract();
  const bases = resolveRealBases(registry).filter((base) => base.tag === regionTag);
  const presets = await loadRegionResourcePresets();
  const resourceLimits = selectRegionResourceLimits(presets, regionTag);
  const options = createDefaultRegionProductionOptions(resourceLimits, overrides);
  return analyzeRegion(registry, regionTag, bases, options, resourceLimits);
}

function utilizationByBase(analysis: RegionAnalysis): number[] {
  return analysis.allocations.map(
    (allocation) => allocation.plan.metrics.deviceArea / allocation.areaBudget,
  );
}

/** 单台满速设备：可选消耗一种外部资源，产出一种带价值物品。 */
function producerVariable(
  baseId: string,
  options: {
    readonly outputItemId: string;
    readonly outputPerMinute: number;
    readonly inputItemId?: string;
    readonly inputPerMinute?: number;
    readonly area?: number;
  },
): RegionLpVariable {
  return {
    baseId,
    candidateId: `${baseId}:${options.outputItemId}`,
    recipeId: `recipe:${options.outputItemId}`,
    machineId: `machine:${options.outputItemId}`,
    machineNameKey: `key:${options.outputItemId}`,
    durationSeconds: 1,
    deviceArea: options.area ?? 1,
    powerDemandPerTick: 0,
    produced: [{ itemId: options.outputItemId, perMinute: options.outputPerMinute }],
    consumed: options.inputItemId === undefined
      ? []
      : [{ itemId: options.inputItemId, perMinute: options.inputPerMinute ?? 0 }],
  };
}

function lpOptions(overrides: Partial<RegionLpOptions> = {}): RegionLpOptions {
  return {
    baseAreaBudget: new Map([["b", 100]]),
    targets: new Map(),
    valueByItemId: new Map([["item_out", 1]]),
    objectiveValueByItemId: new Map([["item_out", 1]]),
    resourceLimits: new Map(),
    infiniteItemIds: new Set(),
    naturalResourceItemIds: new Set(),
    dumpableItemIds: new Set(),
    objective: "value",
    ...overrides,
  };
}

describe("区域产线建模 · 高价值门槛", () => {
  it("门槛以下的券物品被压制在基线速率，不再用剩余面积堆产", async () => {
    const analysis = await analyze("武陵", { highValueThreshold: DEFAULT_HIGH_VALUE_THRESHOLD });
    const limit = analysis.options.targetPerMinute + 1e-6;
    const lowValue = analysis.maxValue.metrics.shipped.filter((entry) =>
      LOW_VALUE_ITEM_IDS.has(entry.itemId),
    );

    expect(lowValue.length).toBeGreaterThan(0);
    for (const entry of lowValue) {
      expect(entry.value).toBeLessThan(DEFAULT_HIGH_VALUE_THRESHOLD);
      expect(entry.perMinute).toBeLessThanOrEqual(limit);
    }
  }, 30_000);

  it("关闭门槛后同一地区会为低价值物品明显扩大产线（对照）", async () => {
    const filtered = await analyze("武陵", { highValueThreshold: DEFAULT_HIGH_VALUE_THRESHOLD });
    const unfiltered = await analyze("武陵", { highValueThreshold: 0 });
    const lowValuePerMinute = (analysis: RegionAnalysis): number =>
      analysis.maxValue.metrics.shipped
        .filter((entry) => LOW_VALUE_ITEM_IDS.has(entry.itemId))
        .reduce((sum, entry) => sum + entry.perMinute, 0);

    expect(lowValuePerMinute(unfiltered)).toBeGreaterThan(lowValuePerMinute(filtered) * 10);
  }, 60_000);
});

describe("区域产线建模 · 均衡分摊与面积可行性", () => {
  it("武陵最优计划经整数化后不超预算，且设备在各基地均衡分摊", async () => {
    const analysis = await analyze("武陵");
    expect(analysis.bases.length).toBe(4);

    const utilization = utilizationByBase(analysis);
    for (const [index, allocation] of analysis.allocations.entries()) {
      expect(allocation.plan.metrics.deviceArea).toBeLessThanOrEqual(allocation.areaBudget + 1e-6);
      expect(utilization[index]).toBeGreaterThan(0);
    }
    // 均衡层目标为「最大化最小基地利用率」：同价值同面积解内各基地利用率必须接近。
    expect(Math.max(...utilization) - Math.min(...utilization)).toBeLessThan(0.08);
    expect(analysis.maxValue.metrics.totalValuePerMinute).toBeGreaterThan(0);
  }, 30_000);

  it("均衡目标在等价最优解内把设备摊到各基地，而非集中在一处", () => {
    const variables = [
      producerVariable("a", {
        outputItemId: "item_out",
        outputPerMinute: 10,
        inputItemId: "item_natural",
        inputPerMinute: 10,
      }),
      producerVariable("b", {
        outputItemId: "item_out",
        outputPerMinute: 10,
        inputItemId: "item_natural",
        inputPerMinute: 10,
      }),
    ];
    const solved = solveRegionLp(
      lpOptions({
        baseAreaBudget: new Map([["a", 100], ["b", 100]]),
        naturalResourceItemIds: new Set(["item_natural"]),
        resourceLimits: new Map([["item_natural", 100]]),
        objective: "balance",
      }),
      variables,
    );

    expect(solved.solution.status).toBe("optimal");
    const [a, b] = solved.deviceCounts;
    expect(a).toBeCloseTo(5, 6);
    expect(b).toBeCloseTo(5, 6);
  });
});

describe("区域产线建模 · 外部供给口径", () => {
  it("未登记上限的自然资源按 0 外供，计划不会静默使用该配方（fail-closed）", () => {
    const variables = [
      producerVariable("b", {
        outputItemId: "item_out",
        outputPerMinute: 10,
        inputItemId: "item_natural",
        inputPerMinute: 10,
      }),
    ];
    const blocked = solveRegionLp(
      lpOptions({ naturalResourceItemIds: new Set(["item_natural"]) }),
      variables,
    );
    expect(blocked.solution.status).toBe("optimal");
    expect(blocked.deviceCounts[0]).toBe(0);

    const allowed = solveRegionLp(
      lpOptions({
        naturalResourceItemIds: new Set(["item_natural"]),
        resourceLimits: new Map([["item_natural", 10]]),
      }),
      variables,
    );
    expect(allowed.solution.status).toBe("optimal");
    expect(allowed.deviceCounts[0]).toBeCloseTo(1, 6);
  });

  it("可排放副产物只允许排放、不允许净消耗，不能靠外部副产物取巧", () => {
    const variables = [
      producerVariable("b", {
        outputItemId: "item_out",
        outputPerMinute: 10,
        inputItemId: "item_liquid_sewage",
        inputPerMinute: 10,
      }),
    ];
    const solved = solveRegionLp(
      lpOptions({ dumpableItemIds: new Set(["item_liquid_sewage"]) }),
      variables,
    );
    expect(solved.solution.status).toBe("optimal");
    expect(solved.deviceCounts[0]).toBe(0);
  });
});
