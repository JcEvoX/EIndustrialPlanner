/**
 * 区域产线建模 · CLI 入口
 *
 * 用法：
 *   node src/scripts/region-production/run.mjs [--bases id1,id2] [--target-per-minute 1] [--out .temp/region-production]
 *
 * 不带参数时对全部真实基地（四号谷地 4 个、武陵 4 个）产出建模报告。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRegistryContract } from "@/registry";
import { analyzeBase, createDefaultRegionProductionOptions } from "./region-plan";
import { buildRegionReport, renderRegionMarkdown } from "./report";
import { resolveBaseById, resolveRealBases } from "./region-scope";

interface CliOptions {
  readonly baseIds: readonly string[];
  readonly targetPerMinute: number;
  readonly outDir: string;
}

const HELP = [
  "区域产线建模脚本",
  "  --bases <id,id>            指定基地 id（缺省：全部真实基地）",
  "  --target-per-minute <n>    全资源基础计划中每种物品的目标速率（缺省 1）",
  "  --out <dir>                输出目录（缺省 .temp/region-production）",
].join("\n");

function parseArgs(argv: readonly string[]): CliOptions {
  let baseIds: string[] = [];
  let targetPerMinute = 1;
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
    if (key === "--bases") {
      baseIds = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    } else if (key === "--target-per-minute") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`无效的 --target-per-minute：${value}`);
      }
      targetPerMinute = parsed;
    } else if (key === "--out") {
      outDir = value;
    } else {
      throw new Error(`未知参数：${key}\n${HELP}`);
    }
  }

  return { baseIds, targetPerMinute, outDir };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const registry = createRegistryContract();
  const bases = cli.baseIds.length > 0
    ? cli.baseIds.map((baseId) => resolveBaseById(registry, baseId))
    : resolveRealBases(registry);

  await mkdir(cli.outDir, { recursive: true });
  const indexLines: string[] = [];

  for (const base of bases) {
    const options = createDefaultRegionProductionOptions(base, {
      targetPerMinute: cli.targetPerMinute,
    });
    const analysis = analyzeBase(registry, base, options);
    const report = buildRegionReport(analysis);

    await writeFile(resolve(cli.outDir, `${base.id}.md`), renderRegionMarkdown(report));
    await writeFile(resolve(cli.outDir, `${base.id}.json`), JSON.stringify(report, null, 2));

    indexLines.push(
      `- [${base.tag} · ${base.name}](${base.id}.md)：券物品 ${report.valuable.length} 种，`
      + `基础计划设备 ${report.allResource.deviceCount} 台 / ${report.allResource.deviceArea} 格，`
      + `基础价值 ${report.allResource.valuePerMinute.toFixed(2)}/min，`
      + `最高单位面积价值 ${report.maxValue.valuePerMinute.toFixed(2)}/min，`
      + `占地利用率 ${(report.maxValue.areaUtilization * 100).toFixed(1)}%`,
    );

    console.log(
      `[region-production] ${base.tag} · ${base.name}：全资源 ${report.allResource.deviceCount} 台 / `
      + `${report.allResource.deviceArea} 格；最高单位面积价值 ${report.maxValue.valuePerMinute.toFixed(2)}/min`,
    );
  }

  await writeFile(
    resolve(cli.outDir, "README.md"),
    `# 区域产线建模报告\n\n${indexLines.join("\n")}\n`,
  );
  console.log(`[region-production] 报告输出目录：${cli.outDir}`);
}

await main();