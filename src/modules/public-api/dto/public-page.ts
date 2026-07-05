export interface PublicPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export function toPublicPage<T>(items: T[], total: number, page: number, limit: number): PublicPage<T> {
  return { items, page, limit, total, hasMore: page * limit < total };
}
