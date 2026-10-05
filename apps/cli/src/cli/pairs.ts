// SPDX-License-Identifier: MIT

import { type Column, renderTable } from "./table.ts";

/**
 * Render a (label, value) pair table — the shared human surface for the
 * single-record write confirmations (`product`/`config`/`environment`
 * create/delete, #678; mirrors the same shape `flag` uses for its create /
 * value commands).
 */
export function renderPairs(pairs: [string, string][]): string {
  const columns: Column<[string, string]>[] = [
    { header: "FIELD", value: (row) => row[0] },
    { header: "VALUE", value: (row) => row[1] },
  ];
  return renderTable(columns, pairs);
}
