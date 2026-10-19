// T8: Vast.ai quote-only interfaces. List/normalize/quote with NO
// provisioning credential and NO chargeable route. A future paid pilot
// needs a separate implementation + approval plan, not a UI toggle.
export interface GpuQuote {
  quoteId: string;
  source: string;
  observedAt: number;
  gpuKind: "cuda";
  gpuModel: string;
  vramMib: number;
  usdPerHour: number;
  feesUnknown: boolean;
}

export interface QuoteRequest {
  minVramMib: number;
  maxUsdPerHour: number;
}

/** Normalize raw marketplace rows into comparable quotes. Pure. */
export function normalizeQuotes(
  rows: Array<Record<string, unknown>>,
  source: string,
  observedAt: number,
): GpuQuote[] {
  const out: GpuQuote[] = [];
  if (!source || typeof source !== "string") return [];
  for (const r of rows) {
    const vram = Number(r.vram_mib ?? r.vram ?? 0);
    const price = Number(r.usd_per_hour ?? r.price ?? NaN);
    const model = String(r.model ?? r.gpu ?? "unknown");
    // Drop unpriced, negative, nonfinite, or unitless rows: never present economics.
    if (!Number.isFinite(price) || price < 0) continue;
    if (!Number.isFinite(vram) || vram <= 0) continue;
    if (model === "unknown") continue;
    out.push({
      quoteId: `${source}:${r.id ?? model}:${observedAt}`,
      source,
      observedAt,
      gpuKind: "cuda",
      gpuModel: model,
      vramMib: vram,
      usdPerHour: price,
      feesUnknown: true, // marketplace fees are never fully in the listing
    });
  }
  return out.sort((a, b) => a.usdPerHour - b.usdPerHour);
}

export function filterQuotes(quotes: GpuQuote[], req: QuoteRequest): GpuQuote[] {
  return quotes.filter((q) => q.vramMib >= req.minVramMib && q.usdPerHour <= req.maxUsdPerHour);
}
