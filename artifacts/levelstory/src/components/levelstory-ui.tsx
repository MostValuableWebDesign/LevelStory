import type { Candle, NtzState, Signal, SignalStatus } from "@workspace/api-client-react";
import type { ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, LockKeyhole, Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { SHADOW_MODE_LABEL } from "@/lib/shadow-mode";

export function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
    <div><div className="eyebrow mb-2.5 text-muted-foreground">{eyebrow}</div><h1 className="display text-3xl font-bold tracking-[-.055em] text-foreground sm:text-[40px]">{title}</h1><p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">{description}</p></div>
    {action}
  </div>;
}

export function Panel({ children, className = "", accent = false }: { children: ReactNode; className?: string; accent?: boolean }) {
  return <section className={`surface relative overflow-hidden rounded-md transition-[border-color,box-shadow] duration-200 ${accent ? "border-l-[3px] border-l-accent" : ""} ${className}`}>{children}</section>;
}

export function PanelTitle({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6"><div>{eyebrow && <div className="eyebrow mb-1.5 text-muted-foreground">{eyebrow}</div>}<h2 className="text-[14px] font-bold tracking-tight">{title}</h2></div>{right}</div>;
}

export function ShadowBadge({ className = "" }: { className?: string }) {
  return <span className={`inline-flex items-center gap-1.5 border border-accent/50 bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.11em] text-foreground ${className}`} data-testid="badge-shadow-mode"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{SHADOW_MODE_LABEL}</span>;
}

export function QuerySkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3 p-6" aria-label="Loading" data-testid="status-loading"><div className="skeleton h-4 w-1/3 rounded" /><div className="skeleton h-9 w-2/3 rounded" />{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-11 w-full rounded" />)}</div>;
}

export function QueryError({ onRetry, message = "We couldn't load this workspace." }: { onRetry: () => void; message?: string }) {
  return <div className="flex flex-col items-start gap-3 p-6" data-testid="status-error"><div className="flex items-center gap-2 text-destructive"><CircleAlert size={18} /><span className="font-semibold">{message}</span></div><p className="text-sm text-muted-foreground">The simulated feed may be taking a breath. Try again.</p><button type="button" onClick={onRetry} className="rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground hover:opacity-90" data-testid="button-retry">Retry feed</button></div>;
}

export function StatusBadge({ status }: { status: SignalStatus }) {
  const config: Record<SignalStatus, { label: string; className: string; icon: LucideIcon }> = { confirmed: { label: "Confirmed", className: "bg-[hsl(var(--positive)/.1)] text-[hsl(var(--positive))] border-[hsl(var(--positive)/.28)]", icon: Check }, watching: { label: "Watching", className: "bg-secondary text-muted-foreground border-border", icon: CircleDashed }, blocked: { label: "Blocked", className: "bg-destructive/10 text-destructive border-destructive/30", icon: Minus } };
  const { icon: Icon, label, className } = config[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${className}`} data-testid={`status-signal-${status}`}><Icon size={11} />{label}</span>;
}

export function MiniCandleChart({ candles, ntz, levels = [] }: { candles: Candle[]; ntz?: NtzState; levels?: Array<{ name: string; price: number }> }) {
  if (!candles?.length) return <div className="flex h-[248px] items-center justify-center text-sm text-muted-foreground" data-testid="empty-candle-chart">No simulated candles yet.</div>;
  const width = 860, height = 248, padX = 22, padY = 20, plotBottom = 190, volumeTop = 207;
  const ntzPrices = ntz?.complete && ntz.high != null && ntz.low != null ? [ntz.high, ntz.low] : [];
  const overlayPrices = [...levels.map((level) => level.price), ...ntzPrices];
  const max = Math.max(...candles.map((c) => c.high), ...overlayPrices), min = Math.min(...candles.map((c) => c.low), ...overlayPrices);
  const scaleY = (v: number) => plotBottom - padY - ((v - min) / Math.max(max - min, .01)) * (plotBottom - padY * 2);
  const step = (width - padX * 2) / candles.length;
  const gridYs = [padY, plotBottom / 2, plotBottom - padY];
  const volumeMax = Math.max(...candles.map((candle) => candle.volume), 1);
  const currentPrice = candles[candles.length - 1].close;
  const currentX = padX + (candles.length - 1) * step + step / 2;
  const completedEvent = ntz?.events.find((event) => event.type === "NTZ completed");
  const ntzStart = completedEvent ? new Date(completedEvent.time).getTime() - 15 * 60_000 : null;
  const ntzStartIndex = ntzStart == null ? -1 : candles.findIndex((candle) => new Date(candle.openTime).getTime() >= ntzStart);
  const ntzEndIndex = completedEvent == null ? -1 : candles.findIndex((candle) => new Date(candle.closeTime).getTime() > new Date(completedEvent.time).getTime());
  const ntzBarCount = ntzStartIndex >= 0 && ntzEndIndex >= 0 ? ntzEndIndex - ntzStartIndex : 0;
  return <div className="w-full overflow-x-auto px-4 pb-3" data-testid="chart-candles"><svg viewBox={`0 0 ${width} ${height}`} className="h-[248px] w-full min-w-[600px]" role="img" aria-label="Simulated five minute candle chart">
    {gridYs.map((y) => <line key={y} x1={0} x2={width} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray={y === height - padY ? "0" : "3 5"} />)}
     {ntz?.complete && ntz.high != null && ntz.low != null && ntzBarCount === 3 && <g data-testid="chart-ntz-range"><rect x={padX + ntzStartIndex * step} y={scaleY(ntz.high)} width={step * 3} height={Math.max(scaleY(ntz.low) - scaleY(ntz.high), 1)} fill="hsl(var(--accent) / .08)" stroke="hsl(var(--accent) / .55)" strokeDasharray="4 4" /><text x={padX + ntzStartIndex * step + 4} y={scaleY(ntz.high) + 12} fill="hsl(var(--accent-foreground))" fontSize="9" fontFamily="DM Mono">NTZ</text><text x={padX + ntzStartIndex * step + step * 3 + 4} y={scaleY(ntz.high) + 4} fill="hsl(var(--muted-foreground))" fontSize="8" fontFamily="DM Mono">H {ntz.high.toFixed(2)}</text><text x={padX + ntzStartIndex * step + step * 3 + 4} y={scaleY(ntz.low) - 2} fill="hsl(var(--muted-foreground))" fontSize="8" fontFamily="DM Mono">L {ntz.low.toFixed(2)}</text></g>}
    {levels.slice(0, 5).map((level) => <g key={level.name}><line x1={padX} x2={width - padX} y1={scaleY(level.price)} y2={scaleY(level.price)} stroke="hsl(var(--accent) / .45)" strokeWidth="1" strokeDasharray="5 5" /><text x={width - padX - 4} y={scaleY(level.price) - 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">{level.name}</text></g>)}
     <line x1={padX} x2={width - padX} y1={scaleY(currentPrice)} y2={scaleY(currentPrice)} stroke="hsl(var(--accent) / .85)" strokeWidth="1" strokeDasharray="2 3" />
     <rect x={width - 72} y={scaleY(currentPrice) - 10} width="64" height="18" rx="2" fill="hsl(var(--accent))" />
     <text x={width - 40} y={scaleY(currentPrice) + 3} textAnchor="middle" fill="hsl(var(--accent-foreground))" fontSize="9" fontWeight="700" fontFamily="DM Mono">{currentPrice.toFixed(2)}</text>
     {candles.map((c, index) => { const x = padX + index * step + step / 2; const up = c.close >= c.open; const color = up ? "hsl(var(--positive))" : "hsl(var(--negative))"; const bodyTop = Math.min(scaleY(c.open), scaleY(c.close)); const bodyHeight = Math.max(Math.abs(scaleY(c.close) - scaleY(c.open)), 3); const volumeHeight = Math.max((c.volume / volumeMax) * 22, 2); return <g key={`${c.time}-${index}`}><line x1={x} x2={x} y1={scaleY(c.high)} y2={scaleY(c.low)} stroke={color} strokeWidth="1.5" /><rect x={x - Math.max(step * .22, 3)} y={bodyTop} width={Math.max(step * .44, 6)} height={bodyHeight} rx="1" fill={color} /><rect x={x - Math.max(step * .18, 2)} y={volumeTop + 22 - volumeHeight} width={Math.max(step * .36, 4)} height={volumeHeight} rx="1" fill={color} opacity=".42" /></g>; })}
     <line x1={padX} x2={width - padX} y1={volumeTop + 23} y2={volumeTop + 23} stroke="hsl(var(--border))" />
    <text x="8" y={padY + 4} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="DM Mono">{max.toFixed(2)}</text>
     <text x="8" y={plotBottom - padY - 5} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="DM Mono">{min.toFixed(2)}</text>
     <text x={currentX} y={height - 4} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">latest</text>
     <text x={padX} y={height - 4} fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">5m candles</text>
  </svg></div>;
}

export function PriceChange({ value, percent }: { value: number; percent: number }) {
  const positive = value >= 0;
  return <span className={`inline-flex items-center gap-1 text-xs font-bold ${positive ? "status-positive" : "status-negative"}`}>{positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{positive ? "+" : ""}{value.toFixed(2)} ({positive ? "+" : ""}{percent.toFixed(2)}%)</span>;
}

export function LockedNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-3 rounded-md border border-border bg-muted/45 p-3 text-xs leading-5 text-muted-foreground"><LockKeyhole size={15} className="mt-0.5 shrink-0" />{children}</div>;
}

export function SignalSummary({ signals }: { signals: Signal[] }) {
  const confirmed = signals.filter((signal) => signal.status === "confirmed").length;
  const blocked = signals.filter((signal) => signal.status === "blocked").length;
  return <div className="flex items-center gap-3 text-[10px] text-muted-foreground"><span className="mono">{confirmed}/{signals.length} confirmed</span>{blocked > 0 && <span className="status-negative">{blocked} blocked</span>}</div>;
}