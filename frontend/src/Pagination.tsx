import { useState } from 'react';

export function usePagination<T>(items: T[], filterKey: string) {
  const [selection, setSelection] = useState({ filter: filterKey, page: 0 });
  const pages = Math.max(1, Math.ceil(items.length / 20));
  const page = selection.filter === filterKey ? Math.min(selection.page, pages - 1) : 0;
  return { visible: items.slice(page * 20, (page + 1) * 20), page, pages, setPage: (page: number) => setSelection({ filter: filterKey, page }) };
}
export function Pagination({ page, pages, setPage, label = 'Directory pagination' }: { label?: string; page: number; pages: number; setPage: (page: number) => void }) {
  return <nav className="directory-pagination" aria-label={label}><button className="filter-reset" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {pages}</span><button className="filter-reset" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button></nav>;
}
