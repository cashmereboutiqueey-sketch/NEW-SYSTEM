import clsx from "clsx";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>
        )}
      </div>
      {actions && <div className="ms-auto shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("card overflow-hidden", className)}>
      {(title || description) && (
        <header className="border-b border-ink-200 px-4 py-3">
          {title && (
            <h2 className="text-sm font-semibold text-ink-800">{title}</h2>
          )}
          {description && (
            <p className="mt-0.5 text-xs text-ink-500">{description}</p>
          )}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export type TileTone = "neutral" | "good" | "warn" | "bad" | "info";

const toneStyles: Record<TileTone, string> = {
  neutral: "text-ink-900",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  pending,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: TileTone;
  /** Marks a figure the costing engine will supply in a later phase. */
  pending?: boolean;
}) {
  return (
    <div className="card p-4">
      <p className="tile-label">{label}</p>
      <p
        className={clsx(
          "tile-value num mt-1.5",
          pending ? "text-ink-300" : toneStyles[tone],
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: TileTone;
}) {
  const styles: Record<TileTone, string> = {
    neutral: "bg-ink-100 text-ink-600",
    good: "bg-good-soft text-good",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    info: "bg-info-soft text-info",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: React.ReactNode[][];
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-400">
        {empty ?? "—"}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-200">
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-3 py-2 text-start text-xs font-medium text-ink-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-ink-100 last:border-0 hover:bg-ink-50"
            >
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-ink-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
