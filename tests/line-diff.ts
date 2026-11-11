// Line by line comparison for test messages: the longest common subsequence of two
// texts' lines, and a short diff. From the bug hunt's area A (agent A's helpers).

/** Longest common subsequence of two line lists, as index pairs. */
export function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** A short diff for failure messages: `-` lines lost, `+` lines added. */
export function diff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const pairs = lcs(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pi) out.push(`- ${JSON.stringify(a[i++])}`);
    while (j < pj) out.push(`+ ${JSON.stringify(b[j++])}`);
    i = pi + 1;
    j = pj + 1;
  }
  return out.join('\n');
}
