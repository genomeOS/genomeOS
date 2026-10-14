/** Roving-tabindex tablist (site redesign spec §3, §8 keyboard; #454).
 *
 * Markup comes from `components/kit/Tablist.astro`: a `[role=tablist]` of `[role=tab]` buttons,
 * each `aria-controls` a `[role=tabpanel]`. Exactly one tab is `aria-selected="true"` at every
 * moment and only it is in the tab order; Arrow keys, Home and End move the selection (automatic
 * activation), and the selected tab's panel is the only one not `hidden`.
 *
 * The tablist dispatches `tabs:change` (detail: { index, id }) on itself whenever the selection
 * changes, by the visitor or by `select()`.
 */

export interface TabsChangeDetail {
  index: number;
  id: string;
  /** True when the visitor caused the change (a click or a key), false for `select()`. */
  user: boolean;
}

export interface Tabs {
  readonly tabs: HTMLElement[];
  readonly selected: number;
  select(index: number, options?: { focus?: boolean; user?: boolean }): void;
}

const NEXT: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function initTabs(list: HTMLElement): Tabs {
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (tabs.length === 0) throw new Error('a tablist needs at least one tab');
  let selected = Math.max(
    0,
    tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
  );

  const panelOf = (tab: HTMLElement) => {
    const id = tab.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };

  const apply = (index: number) => {
    selected = index;
    tabs.forEach((tab, position) => {
      const on = position === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      const panel = panelOf(tab);
      if (panel) panel.hidden = !on;
    });
  };

  const select = (
    index: number,
    { focus = false, user = false }: { focus?: boolean; user?: boolean } = {},
  ) => {
    const changed = index !== selected;
    apply(index);
    if (focus) tabs[index].focus();
    if (changed)
      list.dispatchEvent(
        new CustomEvent<TabsChangeDetail>('tabs:change', {
          bubbles: true,
          detail: { index, id: tabs[index].id, user },
        }),
      );
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index, { user: true }));
    tab.addEventListener('keydown', (event) => {
      const move = NEXT[event.key];
      if (!move) return;
      event.preventDefault();
      select(move(index, tabs.length), { focus: true, user: true });
    });
  });
  // Normalise server markup: one selected, one tab stop, one visible panel.
  apply(selected);

  return {
    tabs,
    get selected() {
      return selected;
    },
    select,
  };
}
