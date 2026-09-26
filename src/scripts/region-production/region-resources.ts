/**
 * 区域产线建模 · 区域自然资源上限读取层（L1 输入）
 *
 * 为什么资源池按「区域」而不是「基地」记：同一地区内多个基地共用同一份自然资源产量，
 * 上限只能记一次，否则会随基地数量被重复放大。
 *
 * 数据源与 App「一键添加版本资源」完全同源：public/module-balancing/version-resources。
 * 解析复用 App 层纯函数（normalizeVersionResourceIndex / normalizeVersionResourcePreset），
 * 不在这里另写一套归一化，避免两处格式漂移。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  normalizeVersionResourceIndex,
  normalizeVersionResourcePreset,
} from "@/app/shell/module-balancing/version-resource-library";

const VERSION_RESOURCE_ROOT = "public/module-balancing/version-resources";

export interface RegionResourceLimits {
  readonly presetId: string;
  readonly presetName: string;
  readonly regionTag: string;
  /** 有限自然资源：每分钟外部供给上限。 */
  readonly limits: ReadonlyMap<string, number>;
  /** 无限供给物品（清水、沉积酸等）。 */
  readonly infiniteItemIds: ReadonlySet<string>;
}

export interface RegionResourcePreset {
  readonly id: string;
  readonly name: string;
  /** 预设声明覆盖的地区 tag；未声明时为 null，表示未绑定地区。 */
  readonly regionTag: string | null;
  readonly limits: ReadonlyMap<string, number>;
  readonly infiniteItemIds: ReadonlySet<string>;
}

/** 读取全部版本资源预设。Node 侧直接读 public 目录，不经过 fetch。 */
export async function loadRegionResourcePresets(
  rootDir: string = VERSION_RESOURCE_ROOT,
): Promise<RegionResourcePreset[]> {
  const indexRaw = JSON.parse(await readFile(resolve(rootDir, "index.json"), "utf8")) as unknown;
  const index = normalizeVersionResourceIndex(indexRaw);
  if (index === null) {
    throw new Error(`版本资源索引格式非法：${rootDir}/index.json`);
  }

  const presets: RegionResourcePreset[] = [];
  for (const name of index.resources) {
    const raw = JSON.parse(await readFile(resolve(rootDir, `${name}.json`), "utf8")) as unknown;
    const preset = normalizeVersionResourcePreset(raw);
    if (preset === null) {
      throw new Error(`版本资源预设格式非法：${rootDir}/${name}.json`);
    }
    const limits = new Map<string, number>();
    const infiniteItemIds = new Set<string>();
    for (const input of preset.inputs) {
      if (input.infinite === true) {
        infiniteItemIds.add(input.itemId);
      } else {
        limits.set(input.itemId, input.perMinute);
      }
    }
    presets.push({
      id: preset.id,
      name: preset.name,
      regionTag: preset.regionTag ?? null,
      limits,
      infiniteItemIds,
    });
  }
  return presets;
}

/**
 * 按地区 tag 选择资源上限预设：
 * - 显式指定 presetId 时以其为准（不存在则报错，不静默回退）；
 * - 否则取目录顺序中第一个匹配该地区的预设（index.json 已按新→旧排列）。
 * 该地区没有任何预设时返回 null，由调用方决定是否报错。
 */
export function selectRegionResourceLimits(
  presets: readonly RegionResourcePreset[],
  regionTag: string,
  presetId?: string,
): RegionResourceLimits | null {
  if (presetId !== undefined) {
    const explicit = presets.find((preset) => preset.id === presetId);
    if (explicit === undefined) {
      throw new Error(`未找到版本资源预设：${presetId}`);
    }
    return toLimits(explicit, regionTag);
  }
  const matched = presets.find((preset) => preset.regionTag === regionTag);
  return matched === undefined ? null : toLimits(matched, regionTag);
}

function toLimits(preset: RegionResourcePreset, regionTag: string): RegionResourceLimits {
  return {
    presetId: preset.id,
    presetName: preset.name,
    regionTag,
    limits: preset.limits,
    infiniteItemIds: preset.infiniteItemIds,
  };
}