export function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '-')
}
