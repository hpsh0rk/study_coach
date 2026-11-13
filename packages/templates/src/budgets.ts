import { BUDGETS as SCHEMA_BUDGETS, CANVAS, FONT, type ListBudget, type TextBudget } from "@kj/schema";

export { CANVAS, FONT, type ListBudget, type TextBudget };

export const BUDGETS = {
  ...SCHEMA_BUDGETS,
  statement: {
    ...SCHEMA_BUDGETS.statement,
    terms: {
      ...SCHEMA_BUDGETS.statement.terms,
      item: { ...SCHEMA_BUDGETS.statement.terms.item, max: 4 },
    },
  },
} as const;
