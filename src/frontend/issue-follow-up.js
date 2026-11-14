/** Put findings with a posted comment on this issue first, newest comment first. */
export function orderIssueFindings(candidates, issueKey) {
  const postedAt = (candidate) => {
    const receipt = candidate.notes?.[issueKey];
    if (!receipt?.commentId) return -Infinity;
    const timestamp = Date.parse(receipt.appliedAt);
    return Number.isFinite(timestamp) ? timestamp : -Number.MAX_VALUE;
  };

  return [...candidates].sort((left, right) => {
    const a = postedAt(left);
    const b = postedAt(right);
    return a === b ? 0 : a > b ? -1 : 1;
  });
}
