/**
 * 区域产线建模 · 线性规划内核
 *
 * 物料配平与面积分摊都需要「多配方环联立 + 线性约束下的最优解」，物料平衡树表达不了环，
 * 因此这里自研两阶段单纯形法作为 L2 的求解底座。
 *
 * 约定：
 * - 变量全部非负；
 * - 目标一律最大化；
 * - 约束支持 <= / >= / =，rhs 允许为负（内部归一化）。
 *
 * 数值策略：密集表 + 主元消去；先用最负检验数加速，退化停滞到阈值后切回 Bland 规则，
 * 保证有限步收敛的同时避免退化循环拖慢大模型。
 */

export type LinearRelation = "<=" | ">=" | "=";

export interface LinearConstraint {
  readonly coefficients: readonly number[];
  readonly relation: LinearRelation;
  readonly rhs: number;
}

export interface LinearProgram {
  readonly variableCount: number;
  readonly constraints: readonly LinearConstraint[];
  /** 最大化目标系数，长度必须等于 variableCount。 */
  readonly objective: readonly number[];
}

export type LinearProgramStatus = "optimal" | "infeasible" | "unbounded" | "iteration-limit";

export interface LinearProgramSolution {
  readonly status: LinearProgramStatus;
  readonly values: readonly number[];
  readonly objectiveValue: number;
  readonly iterations: number;
}

export interface LinearProgramOptions {
  readonly maxIterations?: number;
  readonly tolerance?: number;
}

const DEFAULT_TOLERANCE = 1e-9;
const DEFAULT_MAX_ITERATIONS = 40000;
/** 目标值连续停滞的主元次数超过该值即切回 Bland 规则。 */
const STAGNATION_LIMIT = 48;

interface Tableau {
  readonly rows: Float64Array[];
  readonly basis: Int32Array;
  readonly columnCount: number;
  readonly rhsColumn: number;
}

interface ObjectiveEvaluation {
  readonly reduced: Float64Array;
  readonly value: number;
}

export function maximizeLinearProgram(
  program: LinearProgram,
  options: LinearProgramOptions = {},
): LinearProgramSolution {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const variableCount = program.variableCount;
  if (program.objective.length !== variableCount) {
    throw new Error("目标系数长度与变量数不一致。");
  }

  const normalized = program.constraints.map((constraint) => {
    if (constraint.coefficients.length !== variableCount) {
      throw new Error("约束系数长度与变量数不一致。");
    }
    let coefficients = [...constraint.coefficients];
    let relation = constraint.relation;
    let rhs = constraint.rhs;
    if (rhs < 0) {
      coefficients = coefficients.map((value) => -value);
      rhs = -rhs;
      relation = relation === "<=" ? ">=" : relation === ">=" ? "<=" : "=";
    }
    return { coefficients, relation, rhs };
  });

  const rowCount = normalized.length;
  // 列布局：[原始变量][每行一个松弛/剩余列][每行一个人工列]
  const slackOffset = variableCount;
  const artificialOffset = variableCount + rowCount;
  const columnCount = variableCount + rowCount * 2;
  const rhsColumn = columnCount;
  const rows: Float64Array[] = [];
  const basis = new Int32Array(rowCount);
  const artificialColumns: number[] = [];

  for (let index = 0; index < rowCount; index++) {
    const constraint = normalized[index]!;
    const row = new Float64Array(columnCount + 1);
    for (let column = 0; column < variableCount; column++) {
      row[column] = constraint.coefficients[column]!;
    }
    row[rhsColumn] = constraint.rhs;
    if (constraint.relation === "<=") {
      row[slackOffset + index] = 1;
      basis[index] = slackOffset + index;
    } else {
      if (constraint.relation === ">=") {
        row[slackOffset + index] = -1;
      }
      row[artificialOffset + index] = 1;
      basis[index] = artificialOffset + index;
      artificialColumns.push(artificialOffset + index);
    }
    rows.push(row);
  }

  const tableau: Tableau = { rows, basis, columnCount, rhsColumn };
  const forbiddenPhaseOne = new Uint8Array(columnCount);
  for (const column of artificialColumns) {
    forbiddenPhaseOne[column] = 1;
  }
  const phaseOneCost = new Float64Array(columnCount);
  for (const column of artificialColumns) {
    phaseOneCost[column] = -1;
  }

  const phaseOne = optimize(tableau, phaseOneCost, forbiddenPhaseOne, tolerance, maxIterations);
  if (phaseOne.status === "iteration-limit") {
    return { status: "iteration-limit", values: extractValues(tableau, variableCount), objectiveValue: phaseOne.value, iterations: phaseOne.iterations };
  }
  if (phaseOne.value < -tolerance * Math.max(1, rowCount)) {
    return { status: "infeasible", values: extractValues(tableau, variableCount), objectiveValue: phaseOne.value, iterations: phaseOne.iterations };
  }

  expelArtificialBasis(tableau, artificialColumns, tolerance);

  const phaseTwoCost = new Float64Array(columnCount);
  for (let column = 0; column < variableCount; column++) {
    phaseTwoCost[column] = program.objective[column]!;
  }
  const forbiddenPhaseTwo = new Uint8Array(columnCount);
  for (const column of artificialColumns) {
    forbiddenPhaseTwo[column] = 1;
  }

  const phaseTwo = optimize(tableau, phaseTwoCost, forbiddenPhaseTwo, tolerance, maxIterations);
  return {
    status: phaseTwo.status,
    values: extractValues(tableau, variableCount),
    objectiveValue: phaseTwo.value,
    iterations: phaseOne.iterations + phaseTwo.iterations,
  };
}

function optimize(
  tableau: Tableau,
  cost: Float64Array,
  forbidden: Uint8Array,
  tolerance: number,
  maxIterations: number,
): { readonly status: LinearProgramStatus; readonly iterations: number; readonly value: number } {
  const { rows, basis, rhsColumn } = tableau;
  let iterations = 0;
  let previousValue = Number.NEGATIVE_INFINITY;
  let stagnation = 0;

  while (iterations <= maxIterations) {
    const evaluation = evaluate(tableau, cost);
    if (evaluation.value > previousValue + tolerance) {
      previousValue = evaluation.value;
      stagnation = 0;
    } else {
      stagnation += 1;
    }

    const entering = stagnation < STAGNATION_LIMIT
      ? selectEnteringBySteepest(evaluation.reduced, forbidden, tolerance)
      : selectEnteringByBland(evaluation.reduced, forbidden, tolerance);
    if (entering < 0) {
      return { status: "optimal", iterations, value: evaluation.value };
    }

    let leaving = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rows.length; index++) {
      const coefficient = rows[index]![entering]!;
      if (coefficient <= tolerance) {
        continue;
      }
      const ratio = rows[index]![rhsColumn]! / coefficient;
      if (ratio < bestRatio - tolerance) {
        bestRatio = ratio;
        leaving = index;
      } else if (
        leaving >= 0
        && Math.abs(ratio - bestRatio) <= tolerance
        && basis[index]! < basis[leaving]!
      ) {
        leaving = index;
      }
    }
    if (leaving < 0) {
      return { status: "unbounded", iterations, value: evaluation.value };
    }
    pivot(tableau, leaving, entering);
    iterations += 1;
  }

  return { status: "iteration-limit", iterations, value: previousValue };
}

function evaluate(tableau: Tableau, cost: Float64Array): ObjectiveEvaluation {
  const { rows, basis, columnCount, rhsColumn } = tableau;
  const reduced = new Float64Array(columnCount);
  for (let column = 0; column < columnCount; column++) {
    reduced[column] = cost[column]!;
  }
  let value = 0;
  for (let index = 0; index < rows.length; index++) {
    const multiplier = cost[basis[index]!]!;
    if (multiplier === 0) {
      continue;
    }
    const row = rows[index]!;
    for (let column = 0; column < columnCount; column++) {
      reduced[column] = reduced[column]! - multiplier * row[column]!;
    }
    value += multiplier * row[rhsColumn]!;
  }
  return { reduced, value };
}

function selectEnteringBySteepest(reduced: Float64Array, forbidden: Uint8Array, tolerance: number): number {
  let entering = -1;
  let best = tolerance;
  for (let column = 0; column < reduced.length; column++) {
    if (forbidden[column] === 1) {
      continue;
    }
    if (reduced[column]! > best) {
      best = reduced[column]!;
      entering = column;
    }
  }
  return entering;
}

function selectEnteringByBland(reduced: Float64Array, forbidden: Uint8Array, tolerance: number): number {
  for (let column = 0; column < reduced.length; column++) {
    if (forbidden[column] !== 1 && reduced[column]! > tolerance) {
      return column;
    }
  }
  return -1;
}

function pivot(tableau: Tableau, row: number, column: number): void {
  const { rows, basis, rhsColumn } = tableau;
  const pivotRow = rows[row]!;
  const pivotValue = pivotRow[column]!;
  for (let index = 0; index <= rhsColumn; index++) {
    pivotRow[index] = pivotRow[index]! / pivotValue;
  }
  for (let index = 0; index < rows.length; index++) {
    if (index === row) {
      continue;
    }
    const target = rows[index]!;
    const factor = target[column]!;
    if (factor === 0) {
      continue;
    }
    for (let columnIndex = 0; columnIndex <= rhsColumn; columnIndex++) {
      target[columnIndex] = target[columnIndex]! - factor * pivotRow[columnIndex]!;
    }
  }
  basis[row] = column;
}

/** 阶段一结束后把仍留在基中的人工变量换出，避免阶段二被零值人工变量卡住。 */
function expelArtificialBasis(tableau: Tableau, artificialColumns: readonly number[], tolerance: number): void {
  const { rows, basis, columnCount, rhsColumn } = tableau;
  const artificial = new Set(artificialColumns);
  for (let index = 0; index < rows.length; index++) {
    if (!artificial.has(basis[index]!)) {
      continue;
    }
    const row = rows[index]!;
    for (let column = 0; column < columnCount; column++) {
      if (artificial.has(column) || Math.abs(row[column]!) <= tolerance) {
        continue;
      }
      if (row[rhsColumn]! < -tolerance) {
        continue;
      }
      pivot(tableau, index, column);
      break;
    }
  }
}

function extractValues(tableau: Tableau, variableCount: number): number[] {
  const { rows, basis, rhsColumn } = tableau;
  const values = new Array<number>(variableCount).fill(0);
  for (let index = 0; index < rows.length; index++) {
    const column = basis[index]!;
    if (column < variableCount) {
      const value = rows[index]![rhsColumn]!;
      values[column] = Math.abs(value) <= 1e-12 ? 0 : value;
    }
  }
  return values;
}