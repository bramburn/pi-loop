/**
 * Searchable model picker for /loop-settings.
 *
 * Ports the searchSelector helper from pi-audit-gap (same author, MIT)
 * so the sub-agent model selection has the same typeahead UX as pi's
 * built-in /model selector: a fuzzy-filtering search box over a
 * scrollable list, rendered with pi-tui's own Input + fuzzyFilter
 * primitives via ctx.ui.custom().
 *
 * pi-tui is loaded dynamically at runtime (pi bundles it; extensions
 * resolve it inside the pi process). When pi-tui is unavailable or the
 * session is not a TUI (RPC/JSON/print), the picker falls back to pi's
 * flat ctx.ui.select() dialog so headless environments still work.
 */

export interface PickerTheme {
  fg(color: string, text: string): string;
}

export interface PickerComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export interface PickerUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  custom?<T>(
    factory: (
      tui: unknown,
      theme: PickerTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => PickerComponent | Promise<PickerComponent>,
    options?: unknown,
  ): Promise<T>;
}

export interface SelectableItem {
  value: string;
  label: string;
  /** Secondary line under the label, muted. */
  description?: string;
  /** Extra fuzzy-search target beyond label + value (e.g. provider name). */
  searchHaystack?: string;
}

export interface SearchableSelectArgs {
  title: string;
  hint?: string;
  items: SelectableItem[];
  maxVisible?: number;
  searchPlaceholder?: string;
}

// ---------------------------------------------------------------------------
// pi-tui dynamic loader
// ---------------------------------------------------------------------------

interface PiTuiInput {
  onSubmit?: () => void;
  onEscape?: () => void;
  invalidate?: () => void;
  handleInput(data: string): void;
  getValue(): string;
  render(width: number): string[];
}

interface PiTuiModule {
  fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
  Input: new () => PiTuiInput;
  matchesKey(data: string, key: unknown): boolean;
  Key: Record<string, unknown>;
  visibleWidth(text: string): number;
  wrapTextWithAnsi(text: string, width: number): string[];
}

let piTuiPromise: Promise<PiTuiModule | null> | undefined;

/** Real dynamic import that survives CJS downleveling (TS would emit require()). */
const hostImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

function loadPiTui(): Promise<PiTuiModule | null> {
  if (!piTuiPromise) {
    piTuiPromise = (async () => {
      for (const specifier of ["@earendil-works/pi-tui", "@mariozechner/pi-tui"]) {
        try {
          const mod = (await hostImport(specifier)) as PiTuiModule;
          if (mod && typeof mod.Input === "function" && typeof mod.fuzzyFilter === "function") {
            return mod;
          }
        } catch {
          // Try the next specifier.
        }
      }
      return null;
    })();
  }
  return piTuiPromise;
}

// ---------------------------------------------------------------------------
// Searchable select
// ---------------------------------------------------------------------------

/**
 * Show a searchable picker. Resolves to the picked item, or undefined
 * when the user cancels (Esc).
 */
export async function searchableSelect(
  ctx: { ui: PickerUi },
  args: SearchableSelectArgs,
): Promise<SelectableItem | undefined> {
  const tui = typeof ctx.ui.custom === "function" ? await loadPiTui() : null;
  if (!tui) {
    // Headless / no pi-tui: flat list fallback.
    const choice = await ctx.ui.select(args.title, args.items.map((i) => i.label));
    if (!choice) return undefined;
    return args.items.find((i) => i.label === choice);
  }
  return ctx.ui.custom!<SelectableItem | undefined>((_tui, theme, _kb, done) =>
    buildSelectorComponent(tui, theme, args, done),
  );
}

interface InternalItem extends SelectableItem {
  haystack: string;
}

function buildSelectorComponent(
  tui: PiTuiModule,
  theme: PickerTheme,
  args: SearchableSelectArgs,
  done: (result: SelectableItem | undefined) => void,
): PickerComponent {
  const maxVisible = Math.max(3, args.maxVisible ?? 10);

  const allItems: InternalItem[] = args.items.map((item) => ({
    ...item,
    haystack: (item.searchHaystack ?? `${item.label} ${item.value}`).toLowerCase(),
  }));

  let query = "";
  let filtered: InternalItem[] = allItems;
  let selectedIndex = 0;
  let cachedLines: string[] | undefined;

  const input = new tui.Input();

  const recomputeFilter = (): void => {
    const q = query.trim();
    filtered = q.length === 0 ? allItems : tui.fuzzyFilter(allItems, query, (item) => item.haystack);
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filtered.length - 1)));
  };

  input.onSubmit = () => {
    const selected = filtered[selectedIndex];
    if (!selected) return;
    done(args.items.find((i) => i.value === selected.value));
  };
  input.onEscape = () => done(undefined);
  input.invalidate = () => {
    cachedLines = undefined;
  };

  const handleInput = (data: string): void => {
    if (tui.matchesKey(data, tui.Key.up) || tui.matchesKey(data, tui.Key.down)) {
      if (filtered.length === 0) return;
      if (tui.matchesKey(data, tui.Key.up)) {
        selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
      } else {
        selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
      }
      cachedLines = undefined;
      return;
    }
    if (tui.matchesKey(data, tui.Key.escape)) {
      done(undefined);
      return;
    }
    input.handleInput(data);
    query = input.getValue();
    recomputeFilter();
    cachedLines = undefined;
  };

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;
    const renderWidth = Math.max(1, width);
    const indent = "  ";
    const lines: string[] = [];

    const addWrapped = (text: string): void => {
      lines.push(...tui.wrapTextWithAnsi(text, renderWidth));
    };
    const addWrappedWithPrefix = (prefix: string, text: string): void => {
      const prefixWidth = tui.visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        addWrapped(prefix + text);
        return;
      }
      const wrapped = tui.wrapTextWithAnsi(text, renderWidth - prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push((i === 0 ? prefix : " ".repeat(prefixWidth)) + wrapped[i]);
      }
    };

    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    addWrappedWithPrefix(indent, theme.fg("accent", args.title));
    if (args.searchPlaceholder) {
      addWrappedWithPrefix(indent, theme.fg("muted", args.searchPlaceholder));
    }
    lines.push("");
    for (const line of input.render(Math.max(1, renderWidth - indent.length * 2))) {
      lines.push(indent + line);
    }
    lines.push("");

    if (filtered.length === 0) {
      addWrappedWithPrefix(
        indent,
        query.length > 0
          ? theme.fg("warning", `No matches for "${query}"`)
          : theme.fg("muted", "No models"),
      );
    } else {
      const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, filtered.length);
      for (let i = startIndex; i < endIndex; i++) {
        const item = filtered[i];
        if (!item) continue;
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
        const labelText = isSelected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
        addWrappedWithPrefix(indent, prefix + labelText);
        if (item.description) {
          addWrappedWithPrefix(indent + "    ", theme.fg("muted", item.description));
        }
      }
      if (filtered.length > maxVisible) {
        addWrappedWithPrefix(
          indent,
          theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length} · ${allItems.length} total)`),
        );
      } else {
        addWrappedWithPrefix(indent, theme.fg("dim", `  (${filtered.length}/${allItems.length})`));
      }
    }

    lines.push("");
    addWrappedWithPrefix(
      indent,
      theme.fg("dim", args.hint ?? "Type to search  ↑↓ navigate  Enter select  Esc cancel"),
    );
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    return lines;
  }

  return { render, handleInput, invalidate: () => (cachedLines = undefined) };
}

// ---------------------------------------------------------------------------
// Model picker over pi's model catalogue
// ---------------------------------------------------------------------------

/** Structural shape of a pi ModelRegistry catalogue entry (the real type is richer). */
export interface ModelCatalogEntry {
  id?: string;
  provider?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  type?: string;
}

/** Structural shape of pi's ModelRegistry (Like interface, no `any`). */
export interface ModelCatalogLike {
  getAvailable?(): ModelCatalogEntry[];
  getModelsOfType?(type: string, provider?: string): readonly ModelCatalogEntry[];
  hasConfiguredAuth?(model: ModelCatalogEntry): boolean;
}

export interface LaneModelChoice {
  provider: string;
  modelId: string;
}

/**
 * Show the searchable model picker over pi's catalogue (the same models
 * /model knows about, restricted to chat models with configured auth).
 * Resolves to the picked model, or undefined on cancel / empty catalogue.
 */
export async function pickModelFromCatalog(
  ctx: { ui: PickerUi },
  catalog: ModelCatalogLike | undefined,
  title: string,
): Promise<LaneModelChoice | undefined> {
  const all =
    typeof catalog?.getModelsOfType === "function"
      ? [...catalog.getModelsOfType("chat")]
      : [...(catalog?.getAvailable?.() ?? [])];
  const models = all.filter(
    (m) =>
      !!m &&
      typeof m.id === "string" &&
      typeof m.provider === "string" &&
      (m.type === undefined || m.type === "chat") &&
      (typeof catalog?.hasConfiguredAuth !== "function" || catalog.hasConfiguredAuth(m)),
  );
  if (models.length === 0) return undefined;

  const items: SelectableItem[] = models
    .map((m) => {
      const value = `${m.provider}/${m.id}`;
      const name = m.name && m.name !== m.id ? m.name : undefined;
      return {
        value,
        label: value,
        description: [name, m.api, m.baseUrl]
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .join(" · "),
        searchHaystack: `${value} ${name ?? ""}`.toLowerCase(),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const picked = await searchableSelect(ctx, {
    title,
    searchPlaceholder: "Type to filter providers and models…",
    items,
  });
  if (!picked) return undefined;
  const idx = picked.value.indexOf("/");
  if (idx <= 0 || idx === picked.value.length - 1) return undefined;
  return { provider: picked.value.slice(0, idx), modelId: picked.value.slice(idx + 1) };
}
