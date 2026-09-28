"use client";

import { useMemo, useState } from "react";

export type StyleVariant = {
  variantId: string;
  styleId: string;
  styleName: string;
  sku: string;
  label: string;
  image: string | null;
  styleImage?: string | null;
  available: number;
  makeable?: number;
};

/** Model first, then its SKU choices, as on the POS screen. */
export function StyleVariantPicker<T extends StyleVariant>({
  ar,
  variants,
  kind,
  onSelect,
}: {
  ar: boolean;
  variants: T[];
  kind: "stock" | "make";
  onSelect: (variant: T) => void;
}) {
  const [query, setQuery] = useState("");
  const [openStyleId, setOpenStyleId] = useState<string | null>(null);

  const styles = useMemo(() => {
    const q = query.trim().toLowerCase();
    const grouped = new Map<string, { id: string; name: string; image: string | null; variants: T[] }>();
    for (const variant of variants) {
      const styleMatches = variant.styleName.toLowerCase().includes(q);
      if (q && !styleMatches && !variant.sku.toLowerCase().includes(q) && !variant.label.toLowerCase().includes(q)) continue;
      const group = grouped.get(variant.styleId) ?? {
        id: variant.styleId,
        name: variant.styleName,
        image: variant.styleImage ?? variant.image,
        variants: [],
      };
      group.variants.push(variant);
      grouped.set(variant.styleId, group);
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [query, variants]);

  const openStyle = styles.find((style) => style.id === openStyleId);

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpenStyleId(null); }}
        placeholder={ar ? "دوّر باسم الموديل أو SKU" : "Search model or SKU"}
        aria-label={ar ? "دوّر باسم الموديل أو SKU" : "Search model or SKU"}
        className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 outline-none focus:border-rose-deep"
      />
      {openStyle ? (
        <div className="rounded-lg border border-ink-200 p-3">
          <button type="button" onClick={() => setOpenStyleId(null)} className="mb-3 text-sm font-medium text-rose-deep underline">
            {ar ? "رجوع للموديلات" : "Back to models"}
          </button>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">{openStyle.name}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {openStyle.variants.map((variant) => (
              <button
                key={variant.variantId}
                type="button"
                onClick={() => onSelect(variant)}
                className="flex items-center gap-2 rounded-lg border border-ink-200 p-2 text-start hover:border-rose-deep focus-visible:outline-2 focus-visible:outline-rose-deep"
              >
                {variant.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={variant.image} alt="" className="h-14 w-11 shrink-0 rounded object-cover" />
                ) : null}
                <span className="min-w-0 flex-1 text-xs">
                  <code dir="ltr" className="block font-semibold text-ink-900">{variant.sku}</code>
                  <span className="block text-ink-600">{variant.label}</span>
                  <span className="block text-ink-500">
                    {kind === "stock"
                      ? ar ? `المتاح ${variant.available}` : `${variant.available} available`
                      : ar ? `القماش يكفي ${variant.makeable ?? 0}` : `Cloth makes ${variant.makeable ?? 0}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : styles.length === 0 ? (
        <p role="status" className="py-2 text-sm text-ink-500">{ar ? "مفيش موديل مطابق." : "No matching model."}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {styles.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => setOpenStyleId(style.id)}
              className="overflow-hidden rounded-lg border border-ink-200 text-start hover:border-rose-deep focus-visible:outline-2 focus-visible:outline-rose-deep"
            >
              {style.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={style.image} alt="" className="aspect-[3/4] w-full object-cover" />
              ) : <span className="flex aspect-[3/4] items-center justify-center bg-ink-100 text-xs text-ink-400">{ar ? "مفيش صورة" : "No photo"}</span>}
              <span className="block p-2 text-sm font-medium text-ink-900">{style.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
