// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // filters.js's own shared global (internal/api/static/filters.js) —
  // loaded as a plain <script src> by any page that needs it, same as
  // footer.js/nav.js, rather than ported to TypeScript here: it's still
  // shared with the un-migrated dashboard page (index.html/app.js), so
  // porting it only for Insights would fork the one place this logic
  // used to live in a single tested copy.
  interface SharedFilterState {
    shared: Record<string, string>;
    pr: Record<string, string>;
    issue: Record<string, string>;
  }

  interface FilterableItem {
    forge: string;
    repo: string;
    title: string;
    author?: string;
    createdAt: string;
    updatedAt: string;
    ci?: string;
    labels?: { name: string }[];
  }

  interface Window {
    Filters: {
      FORGE_LABELS: Record<string, string>;
      DEPENDENCY_DASHBOARD_TITLE: string;
      loadState(): SharedFilterState;
      loadStateFromServer(): Promise<Partial<SharedFilterState> | null>;
      applyServerState(
        state: SharedFilterState,
        got: Partial<SharedFilterState>,
      ): void;
      saveState(state: SharedFilterState, debouncedCol?: string): void;
      minutesAgo(iso: string): number;
      matchesFilters(
        item: FilterableItem,
        isPR: boolean,
        shared: Record<string, string>,
        extra: Record<string, string> | undefined,
      ): boolean;
      distinctValues(
        getValues: (item: FilterableItem) => string | string[] | undefined,
        items: FilterableItem[],
      ): string[];
      populateSelect(
        select: HTMLSelectElement | null,
        values: string[],
        previous: string,
      ): boolean;
      populateDatalist(
        datalist: HTMLDataListElement | null,
        values: string[],
      ): void;
      populateRepoSelect(
        select: HTMLSelectElement | null,
        items: FilterableItem[],
      ): boolean;
    };
  }
}

export {};
