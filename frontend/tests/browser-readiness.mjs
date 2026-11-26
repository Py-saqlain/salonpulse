// CDP returnByValue cannot serialize React DOM nodes (their internal references
// are cyclic/deep). Readiness predicates must return primitive booleans.
export async function waitForCondition(evaluate, expression, label, { timeout = 20000, interval = 100 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await evaluate(`Boolean(${expression})`)) return; }
    catch (error) {
      // Navigation can replace an execution context. All application and other
      // protocol errors still fail verification immediately.
      if (!error.navigationContextUnavailable) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Browser condition timed out: ' + label);
}
