export function toPiUsage(usage) {
  if (!usage) return undefined;

  const inputTokens = finiteOrZero(usage.inputTokens);
  const outputTokens = finiteOrZero(usage.outputTokens);
  const cacheReadTokens = finiteOrZero(usage.cacheReadTokens);
  const cacheWriteTokens = finiteOrZero(usage.cacheWriteTokens);
  const totalTokens = finiteOrZero(usage.totalTokens) || inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
  };
}

export function addPiUsage(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: finiteOrZero(left.cost?.input) + finiteOrZero(right.cost?.input),
      output: finiteOrZero(left.cost?.output) + finiteOrZero(right.cost?.output),
      cacheRead: finiteOrZero(left.cost?.cacheRead) + finiteOrZero(right.cost?.cacheRead),
      cacheWrite: finiteOrZero(left.cost?.cacheWrite) + finiteOrZero(right.cost?.cacheWrite),
      total: finiteOrZero(left.cost?.total) + finiteOrZero(right.cost?.total)
    }
  };
}

function finiteOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
