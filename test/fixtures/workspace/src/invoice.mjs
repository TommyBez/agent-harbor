export function invoiceTotal(rows, discountPercent = 0) {
  if (!Array.isArray(rows) || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new TypeError('Expected invoice rows and a discount between 0 and 100.');
  }
  const cents = rows.reduce((sum, row) => {
    if (!Number.isInteger(row.quantity) || row.quantity < 0 || !Number.isFinite(row.unitPrice) || row.unitPrice < 0) {
      throw new TypeError('Each row needs a nonnegative integer quantity and a finite nonnegative price.');
    }
    return sum + row.quantity * Math.round(row.unitPrice * 100);
  }, 0);
  return Math.round(cents * (1 - discountPercent / 100)) / 100;
}
