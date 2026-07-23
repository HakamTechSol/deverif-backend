/**
 * Parse and validate pagination query parameters.
 * @param {object} query - req.query
 * @param {object} opts - { defaultLimit: 20, maxLimit: 100 }
 * @returns {{ page: number, limit: number, offset: number }}
 */
export function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Build the standard paginated response shape.
 * @param {Array} items - The page of rows
 * @param {number} total - Total row count
 * @param {number} page - Current page
 * @param {number} limit - Page size
 * @returns {{ items, total, page, totalPages }}
 */
export function paginatedResponse(items, total, page, limit) {
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}
