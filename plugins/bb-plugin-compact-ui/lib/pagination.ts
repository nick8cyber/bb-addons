/** Local, immutable paging state. Zero keeps the existing "show all" mode. */
export interface PageState {
  base: number;
  budgets: ReadonlyMap<string, number>;
}

export const createPageState = (base: number): PageState => ({ base, budgets: new Map() });

export function reconcilePages(
  state: PageState,
  base: number,
  projectIds: readonly string[],
  ready: boolean,
): PageState {
  if (state.base !== base) return createPageState(base);
  if (!ready) return state;
  const keys = new Set(projectIds.map(id => `project:${id}`));
  if ([...state.budgets.keys()].every(key => keys.has(key))) return state;
  return { base, budgets: new Map([...state.budgets].filter(([key]) => keys.has(key))) };
}

export function setPageBudget(state: PageState, key: string, budget: number): PageState {
  const budgets = new Map(state.budgets);
  if (budget <= state.base) budgets.delete(key);
  else budgets.set(key, budget);
  return { ...state, budgets };
}

export function pageSteps(base: number, budget: number, ordinaryCount: number) {
  if (base === 0) return { next: 0, previous: 0, more: 0, canLess: false };
  const next = (Math.floor(budget / 10) + 1) * 10;
  const previous = Math.max(base, Math.floor((Math.min(budget, ordinaryCount) - 1) / 10) * 10);
  return {
    next,
    previous,
    more: Math.max(0, Math.min(next, ordinaryCount) - Math.min(budget, ordinaryCount)),
    canLess: budget > base,
  };
}
