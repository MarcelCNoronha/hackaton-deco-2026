import type { CatalogFilterOptions } from "../api/client";

/** Same filter fields (busca por nome/SKU + categoria + marca) reused across Produtos, Histórico
 *  e Impacto, so the three pages stay consistent. */
export function CatalogFilterBar(props: {
  search: string;
  setSearch: (value: string) => void;
  categoryId: string;
  setCategoryId: (value: string) => void;
  brandId: string;
  setBrandId: (value: string) => void;
  filters: CatalogFilterOptions | null;
  onSubmit: (e: React.FormEvent) => void;
  searchPlaceholder?: string;
}) {
  return (
    <form onSubmit={props.onSubmit} className="form-grid">
      <span className="search-input-wrap">
        <span className="search-input-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          placeholder={props.searchPlaceholder ?? "Buscar por nome ou SKU"}
          value={props.search}
          onChange={(e) => props.setSearch(e.target.value)}
        />
      </span>
      <select value={props.categoryId} onChange={(e) => props.setCategoryId(e.target.value)}>
        <option value="">Todas as categorias</option>
        {props.filters?.categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select value={props.brandId} onChange={(e) => props.setBrandId(e.target.value)}>
        <option value="">Todas as marcas</option>
        {props.filters?.brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button type="submit" className="filter-submit-btn">
        Filtrar
      </button>
    </form>
  );
}
