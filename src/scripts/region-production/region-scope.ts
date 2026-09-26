/**
 * 区域产线建模 · 区域范围层（L1）
 *
 * 目标：把「某个基地在游戏里能建什么、能产什么、能换什么」从 registry 中确定下来。
 * 本层只做事实提取，不做任何假设性推测：
 * - 设备可摆放性沿用 app 层 canPlaceEntityDefinitionInBase 的地区归属规则；
 * - 物品价值沿用 item-definition 中的「调度券地区 / 调度券价值」标签。
 */

import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { BaseDefinition } from "@/domain/registry/types/base-definition";
import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { ItemDefinition } from "@/domain/registry/types/item-definition";
import { ALL_REGION_ENTITIES_BASE_TAG } from "@/shared/base-tags";

const DISPATCH_TICKET_REGION_TAG_PREFIX = "调度券地区:";
const DISPATCH_TICKET_VALUE_TAG_PREFIX = "调度券价值:";

export interface DispatchTicketValue {
  readonly region: string;
  readonly value: number;
}

export interface RegionValuableItem {
  readonly itemId: string;
  readonly nameKey: string;
  readonly value: number;
}

/** 解析物品的调度券地区与价值；缺失或非法时返回 null。 */
export function parseDispatchTicketValue(
  item: Pick<ItemDefinition, "tags">,
): DispatchTicketValue | null {
  const regionTag = item.tags.find((tag) => tag.startsWith(DISPATCH_TICKET_REGION_TAG_PREFIX));
  const valueTag = item.tags.find((tag) => tag.startsWith(DISPATCH_TICKET_VALUE_TAG_PREFIX));
  if (regionTag === undefined || valueTag === undefined) {
    return null;
  }
  const region = regionTag.slice(DISPATCH_TICKET_REGION_TAG_PREFIX.length);
  const value = Number(valueTag.slice(DISPATCH_TICKET_VALUE_TAG_PREFIX.length));
  if (region.length === 0 || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return { region, value };
}

/**
 * 地区归属判定，语义与 app 层 canPlaceEntityDefinitionInBase 一致，但去掉 AppHost 依赖。
 * 规则：未标注任何已注册地区 tag 的设备视为通用设备；标注了地区 tag 的设备只在同地区基地可用。
 */
export function canPlaceEntityDefinitionInBase(
  registry: RegistryContract,
  base: BaseDefinition,
  definition: EntityDefinition,
): boolean {
  if (base.tags.includes(ALL_REGION_ENTITIES_BASE_TAG)) {
    return true;
  }
  const regionTags = new Set(registry.baseDefinitions.map((candidate) => candidate.tag));
  const entityRegions = definition.tags.filter((tag) => regionTags.has(tag));
  return entityRegions.length === 0 || entityRegions.includes(base.tag);
}

/** 真实可游玩基地（排除草稿箱这种 allRegion 工具空间）。 */
export function resolveRealBases(registry: RegistryContract): BaseDefinition[] {
  return registry.baseDefinitions.filter((base) => !base.tags.includes(ALL_REGION_ENTITIES_BASE_TAG));
}

export function resolveBaseById(registry: RegistryContract, baseId: string): BaseDefinition {
  const base = registry.baseDefinitions.find((candidate) => candidate.id === baseId);
  if (base === undefined) {
    throw new Error(`未知基地：${baseId}`);
  }
  return base;
}

/** 该基地所属地区下、带有调度券价值的物品，按价值降序。 */
export function resolveRegionValuableItems(
  registry: RegistryContract,
  base: BaseDefinition,
): RegionValuableItem[] {
  const result: RegionValuableItem[] = [];
  for (const item of registry.itemDefinitions) {
    const ticket = parseDispatchTicketValue(item);
    if (ticket === null || ticket.region !== base.tag) {
      continue;
    }
    result.push({ itemId: item.id, nameKey: item.nameKey, value: ticket.value });
  }
  return result.sort((left, right) => right.value - left.value);
}

/**
 * 构造「地区内可用」的 registry 视图：只保留该基地可摆放的实体，以及其机器可摆放的配方。
 * 未知机器（registry 中查不到 machineId）不做剔除，避免误删特殊配方。
 */
export function createRegionScopedRegistry(
  registry: RegistryContract,
  base: BaseDefinition,
): RegistryContract {
  const entityById = new Map(registry.entityDefinitions.map((entity) => [entity.id, entity]));
  const isMachineAvailable = (machineId: string): boolean => {
    const machine = entityById.get(machineId);
    return machine === undefined || canPlaceEntityDefinitionInBase(registry, base, machine);
  };

  return {
    ...registry,
    entityDefinitions: registry.entityDefinitions.filter((entity) =>
      canPlaceEntityDefinitionInBase(registry, base, entity),
    ),
    recipeDefinitions: registry.recipeDefinitions.filter((recipe) => isMachineAvailable(recipe.machineId)),
  };
}