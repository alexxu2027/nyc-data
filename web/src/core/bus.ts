// Bus text helpers (ADR-018), shared by the map tooltip and the drawer.

/** "SELECT BUS SERVICE SOUTH FERRY via 2 AV" -> "SOUTH FERRY via 2 AV" (the service has its own row). */
export function headsignOnly(h: string | null | undefined): string | null {
  if (!h) return null;
  const out = h.replace(/^SELECT BUS( SERVICE)?\s+/i, '').replace(/\s{2,}/g, ' ').trim();
  return out || h;
}
