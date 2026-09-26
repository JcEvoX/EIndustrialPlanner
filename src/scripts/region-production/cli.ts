/**
 * 区域产线建模 · CLI 入口
 *
 * 用法：
 *   node src/scripts/region-production/run.mjs [--regions 武陵,四号谷地] [--target-per-minute 1]
 *                                            [--high-value-threshold 25]
 *                                            [--resource-preset version-resource:wuling-1.5]
 *                                            [--out .temp/region-production]
 *
 * 不带参数时对全部真实地区（按基地 tag 分组）产出区域报告。
 * AI-CORRECTION 2026-09-26: 输出单位由「单个基地」升级为「地区」。
 * 原因：资源池按大区域共享，必须区域级统一求解后分摊，逐基地报告会让同一份资源上限被按基地数量重复放大。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRegistryContract } from "@/registry";
import {
  analyzeRegion,
  createDefaultRegionProductionOptions,
  DEFAULT_HIGH_VALUE_THRESHOLD,
} from "./region-plan";
import { buildRegionReport, renderRegionMarkdown } from "./report";
import { loadRegionResourcePresets, selectRegionResourceLimits } from "./region-resources";
import { resolveRealBases } from "./region-scope";

interface CliOptions {
  readonly regions: readonly string[];
  readonly targetPerMinute: number;
  readonly highValueThreshold: number;
  readonly resourcePresetId: string | undefined;
  readonly outDir: string;
}

const HELP = [
  "区域产线建模脚本",
  "  --regions <tag,tag>        指定地区 tag（基地 tag，缺省：全部真实地区）",
  "  --target-per-minute <n>    全资源基础计划中每种物品的目标速率（缺省 1）",
  `  --high-value-threshold <n> 参与最高价值计划的调度券价值门槛（缺省 ${DEFAULT_HIGH_VALUE_THRESHOLD}；0 = 不过滤）`,
  "  --resource-preset <id>     指定版本资源预设 id（缺省：按地区自动匹配）",
  "  --out <dir>                输出目录（缺省 .temp/region-production）",
].join("\n");

function parseArgs(argv: readonly string[]): CliOptions {
  let regions: string[] = [];
  let targetPerMinute = 1;
  let highValueThreshold = DEFAULT_HIGH_VALUE_THRESHOLD;
  let resourcePresetId: string | undefined;
  let outDir = ".temp/region-production";

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--help") {
      console.log(HELP);
      process.exit(0);
    }
    if (value === undefined) {
      throw new Error(`缺少参数值：${key}`);
    }
    if (key === "--regions") {
      regions = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    } else if (key === "--target-per-minute") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`无效的 --target-per-minute：${value}`);
      }
      targetPerMinute = parsed;
    } else if (key === "--high-value-threshold") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`无效的 --high-value-threshold：${value}`);
      }
      highValueThreshold = parsed;
    } else if (key === "--resource-preset") {
      resourcePresetId = value;
    } else if (key === "--out") {
      outDir = value;
    } else {
      throw new Error(`未知参数：${key}\n${HELP}`);
    }
  }

  return { regions, targetPerMinute, highValueThreshold, resourcePresetId, outDir };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const registry = createRegistryContract();
  const realBases = resolveRealBases(registry);
  const regionTags = cli.regions.length > 0
    ? [...cli.regions]
    : [...new Set(realBases.map((base) => base.tag))];
  const presets = await loadRegionResourcePresets();

  await mkdir(cli.outDir, { recursive: true });
  const indexLines: string[] = [];

  for (const regionTag of regionTags) {
    const bases = realBases.filter((base) => base.tag === regionTag);
    if (bases.length === 0) {
      console.warn(`[region-production] 跳过地区「${regionTag}」：没有已登记的基地。`);
      continue;
    }

    const resourceLimits = selectRegionResourceLimits(presets, regionTag, cli.resourcePresetId);
    const options = createDefaultRegionProductionOptions(resourceLimits, {
      targetPerMinute: cli.targetPerMinute,
      highValueThreshold: cli.highValueThreshold,
    });
    const analysis = analyzeRegion(registry, regionTag, bases, options, resourceLimits);
    const report = buildRegionReport(analysis);

    await writeFile(resolve(cli.outDir, `${regionTag}.md`), renderRegionMarkdown(report));
    await writeFile(resolve(cli.outDir, `${regionTag}.json`), JSON.stringify(report, null, 2));

    indexLines.push(
      `- [${regionTag}](${encodeURIComponent(regionTag)}.md)：基地 ${report.bases.length} 个，`
      + `资源预设 ${report.resourcePreset?.id ?? "无（不设上限）"}，`
      + `券物品 ${report.valuable.length} 种，`
      + `基础计划设备 ${report.allResource.deviceCount} 台 / ${report.allResource.deviceArea} 格，`
      + `基础价值 ${report.allResource.valuePerMinute.toFixed(2)}/min，`
      + `最高价值 ${report.maxValue.valuePerMinute.toFixed(2)}/min，`
      + `面积利用率 ${(report.maxValue.areaUtilization * 100).toFixed(1)}%`,
    );

    console.log(
      `[region-production] ${regionTag}：基地 ${report.bases.length} 个；`
      + `全资源 ${report.allResource.deviceCount} 台 / ${report.allResource.deviceArea} 格；`
      + `最高价值 ${report.maxValue.valuePerMinute.toFixed(2)}/min；`
      + `面积利用率 ${(report.maxValue.areaUtilization * 100).toFixed(1)}%`,
    );
  }

  await writeFile(
    resolve(cli.outDir, "README.md"),
    `# 区域产线建模报告\n\n${indexLines.join("\n")}\n`,
  );
  console.log(`[region-production] 报告输出目录：${cli.outDir}`);
}

await main();