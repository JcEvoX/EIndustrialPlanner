/**
 * 区域产线建模 · 布局面积口径（L2 共享假设）
 *
 * 区域 LP 的面积约束、整数化可行性复核、指标层报告的「占地 / 利用率」必须使用同一套面积口径，
 * 否则会出现「约束按 A 计、报告按 B 计」的结构性不一致（历史上曾因此导出不可布局的计划）。
 * 本模块是该口径的唯一来源。
 */

/**
 * 设备四周强制预留的物流通道宽度（格），对齐 blueprint-planner/placement.ts 的 `deviceClearance`
 * 默认值（设备间必须留出可走线通道）。此处按常量复制而非跨模块引用：区域建模只借用 EDA 的通道口径
 * 作为面积估算假设，不应把 blueprint-planner 的实现依赖引入求解层。
 */
const PLANNER_DEVICE_CLEARANCE = 2;

/**
 * 物流占地倍率：通道之外的传送带 / 管道 / 物流建筑 / 端口缓冲区，相对「本体 + 通道」面积的倍率。
 *
 * 标定依据（EDA 单配方蓝图实测「实际占地 ÷（本体+通道）面积」）：
 * - 粉碎机 10 台：1650 ÷ (7×7×10) ≈ 3.4；
 * - 粉碎机 20 台：1560 ÷ (7×7×20) ≈ 1.6；
 * - 天有洪炉 4 台：648 ÷ (9×9×4) = 2.0。
 * 取中位 2.0 作为默认：偏保守，宁可少排设备也不产出越界蓝图。机器本体越大，该倍率越低
 * （通道与物流占地随本体尺寸被摊薄），固定倍率是这一趋势的一阶近似。
 */
const LOGISTICS_AREA_FACTOR = 2;

/**
 * 单台设备在基地内实际占用的面积（格）。
 *
 * AI-CORRECTION 2026-09-28: 原实现（region-lp.ts 内联 + plan-metrics.ts 内联）只按设备本体
 * `footprint.width * footprint.height` 计面积，完全忽略传送带、管道、仓库与端口缓冲区。
 * 结果是以 footprint 口径算出「刚好塞满基地」的设备数（武陵 476 台 / 10167 格，占基地面积 73%），
 * 但这些设备按 EDA 的真实布局需要约 4~6 倍占地，蓝图无法在基地边界内生成。
 * 新行为：`有效占地 = (本体宽 + 2 × 通道) × (本体高 + 2 × 通道) × 物流倍率`。
 * 风险：倍率是经验常量，极端机型的实际占地仍可能偏离；需以 EDA 实测复核（见文件头测试约定）。
 */
export function resolveLayoutDeviceArea(footprintWidth: number, footprintHeight: number): number {
  // 面积系数必须为正，否则求解器可以无成本堆设备导致目标无界。
  if (footprintWidth <= 0 || footprintHeight <= 0) {
    return 1;
  }
  const padded =
    (footprintWidth + 2 * PLANNER_DEVICE_CLEARANCE)
    * (footprintHeight + 2 * PLANNER_DEVICE_CLEARANCE);
  return padded * LOGISTICS_AREA_FACTOR;
}