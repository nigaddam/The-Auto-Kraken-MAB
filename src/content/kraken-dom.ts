/** Low-level, semantic-first DOM query helpers for the Kraken Prop page.
 *
 * These are deliberately generic and layered with fallbacks because this
 * file is being written without access to Kraken's real, current DOM. Per
 * the project's own rules, nothing here may rely on screen coordinates, row
 * position alone, icon shape alone, or a randomized CSS class as the *sole*
 * locator. When ambiguous, functions return null/[] rather than guess — the
 * caller treats that as "can't act here", not "assume a value".
 *
 * NEXT STEP: run this against the real, logged-in Kraken Prop page and
 * adjust the keyword lists / attribute names below from what's actually
 * observed. Nothing here has been validated against production Kraken yet.
 */

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Only this element's own direct text-node children — not descendant
 * text. Used to find "exact text anchors" (e.g. a leaf that literally says
 * "Long") without matching some large ancestor that merely *contains* the
 * word somewhere deep inside. */
export function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Elements whose *own* text contains one of `words` as a whole word (not
 * a substring of a longer word) — e.g. matches "Long" or "XPL/USD" but not
 * "Longitude" or "JTOKEN". */
export function findElementsWithOwnTextWord(root: ParentNode, words: string[]): Element[] {
  const all = Array.from(root.querySelectorAll<Element>("*"));
  return all.filter((el) => {
    const text = el.children.length === 0 ? textOf(el) : ownText(el);
    if (text.length === 0) return false;
    return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  });
}

/** Strips currency symbols, commas, percent signs, and handles a leading
 * minus or parenthesized-negative convention. Returns null if it doesn't
 * look like a number at all (never guesses). */
export function parseNumberFromText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const isParenNegative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/[()]/g, "")
    .replace(/[$,%]/g, "")
    .replace(/[^\d.\-+]/g, "");
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return isParenNegative ? -Math.abs(value) : value;
}

function matchesAnyKeyword(value: string | null | undefined, keywords: RegExp[]): boolean {
  if (!value) return false;
  return keywords.some((re) => re.test(value));
}

/** Finds the most likely "open positions" table/list on the page. Prefers
 * an element with an accessible role of table/grid whose name (aria-label,
 * or a nearby heading) mentions positions; falls back to any role=table
 * containing at least one row with LONG/SHORT text; and — when the page
 * has no such role/data-testid markers at all (plain divs) — falls back
 * further to the nearest common ancestor of an "Open positions"/"Positions"
 * heading. */
export function findPositionsContainer(root: ParentNode): Element | null {
  const candidates = Array.from(
    root.querySelectorAll<Element>('[role="table"], table, [role="grid"], [data-testid*="position" i]')
  );

  const labeled = candidates.find((el) => {
    const label = el.getAttribute("aria-label") ?? el.getAttribute("title");
    if (matchesAnyKeyword(label, [/position/i])) return true;
    const heading = el.closest("section, div")?.querySelector("h1, h2, h3, h4");
    return matchesAnyKeyword(textOf(heading), [/open positions/i, /^positions$/i]);
  });
  if (labeled) return labeled;

  const textMatch = candidates.find((el) => /\b(long|short)\b/i.test(textOf(el)));
  if (textMatch) return textMatch;
  if (candidates.length > 0) return candidates[0]!;

  const headings = Array.from(root.querySelectorAll<Element>("h1, h2, h3, h4"));
  const heading = headings.find((h) => matchesAnyKeyword(textOf(h), [/open positions/i, /^positions$/i]));
  if (heading) {
    return heading.parentElement ?? heading;
  }

  return null;
}

/** Row elements within a positions container, excluding header-only rows. */
export function findPositionRows(container: Element): Element[] {
  const rowCandidates = Array.from(
    container.querySelectorAll<Element>('[role="row"], tr, [data-testid*="position-row" i]')
  );
  return rowCandidates.filter((row) => {
    if (row.querySelector("th") && !row.querySelector("td, [role='cell'], [role='gridcell']")) {
      return false; // header row
    }
    return /\b(long|short)\b/i.test(textOf(row));
  });
}

/** All "Close position"-labeled controls anywhere in the row's subtree,
 * matched by accessible name/text, or (for icon-only controls with no name
 * at all) a data-testid mentioning "close". Note this searches descendants,
 * so if `row` itself wraps a nested candidate row (a summary row containing
 * its own actionable child row), this returns the nested row's control too
 * — see resolveOwnedCloseControls below, which resolves ownership to the
 * innermost row when candidate rows are nested. */
export function findCloseControlCandidates(row: Element): Element[] {
  const buttonLike = Array.from(
    row.querySelectorAll<Element>('button, [role="button"], a[role="button"]')
  );
  return buttonLike.filter((el) => {
    const name = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? textOf(el);
    if (/close/i.test(name)) return true;
    const testId = el.getAttribute("data-testid");
    return testId !== null && /close/i.test(testId);
  });
}

/** The row-scoped "Close position" control, matched by accessible name/text
 * — never by position, icon alone, or a page-global selector. Returns the
 * first match; use resolveOwnedCloseControls instead when rows may be
 * nested (summary + actionable child) and ownership must be disambiguated. */
export function findCloseControlInRow(row: Element): Element | null {
  return findCloseControlCandidates(row)[0] ?? null;
}

/** Resolves each candidate row's *own* Close control, disambiguating the
 * case where rows are nested (a summary row containing its actionable
 * child). A control belongs to the innermost candidate row that contains
 * it — not every ancestor row that happens to contain it via
 * querySelectorAll's subtree search. Returns one entry per row, in the
 * same order; `null` when that row doesn't directly own a close control. */
export function resolveOwnedCloseControls(rows: Element[]): (Element | null)[] {
  const allControls = new Set<Element>();
  for (const row of rows) {
    for (const control of findCloseControlCandidates(row)) {
      allControls.add(control);
    }
  }

  const owner: (Element | null)[] = rows.map(() => null);
  for (const control of allControls) {
    const containingIndexes = rows
      .map((r, i) => (r.contains(control) ? i : -1))
      .filter((i) => i >= 0);
    if (containingIndexes.length === 0) continue;

    let innermost = containingIndexes[0]!;
    for (const idx of containingIndexes) {
      if (rows[innermost]!.contains(rows[idx]!) && rows[innermost] !== rows[idx]) {
        innermost = idx;
      }
    }
    owner[innermost] = control;
  }
  return owner;
}

/** Looks for a value associated with one of the given label keywords, in
 * order of confidence: data-testid, aria-label/title, then a label:value
 * text pattern within the row. Returns null (not a guess) if nothing
 * matches clearly. */
export function findLabeledText(row: Element, labelKeywords: RegExp[]): string | null {
  const testIdMatch = Array.from(row.querySelectorAll<Element>("[data-testid]")).find((el) =>
    matchesAnyKeyword(el.getAttribute("data-testid"), labelKeywords)
  );
  if (testIdMatch) return textOf(testIdMatch);

  const ariaMatch = Array.from(row.querySelectorAll<Element>("[aria-label], [title]")).find((el) =>
    matchesAnyKeyword(el.getAttribute("aria-label") ?? el.getAttribute("title"), labelKeywords)
  );
  if (ariaMatch) return textOf(ariaMatch);

  const rowText = textOf(row);
  for (const keyword of labelKeywords) {
    const match = rowText.match(
      new RegExp(keyword.source + String.raw`\s*[:\-]?\s*([\-+$()\d.,%]+)`, "i")
    );
    // Read the *last* group, not group 1 — if `keyword` itself contains a
    // capturing group (e.g. "open(ing)?\s*price"), the value we appended
    // ends up at a higher index, not necessarily 1.
    const value = match?.[match.length - 1];
    if (value) return value;
  }
  return null;
}
