export function canonicalToDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export function dateToCanonical(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

export function formatDateForDisplay(value: string): string {
  const date = canonicalToDate(value);
  return date ? `${(date.getMonth() + 1).toString().padStart(2, "0")}/${date.getDate().toString().padStart(2, "0")}/${date.getFullYear()}` : value;
}

export function parseDateText(value: string): string | null {
  const trimmed = value.trim();
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  const year = Number(slashMatch?.[3] ?? isoMatch?.[1]);
  const month = Number(slashMatch?.[1] ?? isoMatch?.[2]);
  const day = Number(slashMatch?.[2] ?? isoMatch?.[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return dateToCanonical(date);
}