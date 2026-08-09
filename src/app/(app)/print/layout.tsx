import "../../print.css";

/**
 * The print area.
 *
 * Deliberately bare: the application shell — sidebar, header, entity switcher
 * — is chrome, and the print stylesheet hides it, but keeping it out of the
 * tree entirely means a document previews at its real size on screen too.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="print-preview">{children}</div>;
}
