import type { Candle, Signal, SignalStatus } from "@workspace/api-client-react";
import type { ReactNode } from "react";
import { Check, CircleAlert, CircleDashed, LockKeyhole, Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";

export function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
    <div><div className="eyebrow mb-2.5 text-muted-foreground">{eyebrow}</div><h1 className="display text-3xl font-bold tracking-[-.055em] text-foreground sm:text-[40px]">{title}</h1><p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">{description}</p></div>
    {action}
  </div>;
}

export function Panel({ children, className = "", accent = false }: { children: ReactNode; className?: string; accent?: boolean }) {
  return <section className={`surface relative overflow-hidden rounded-md ${accent ? "border-l-[3px] border-l-accent" : ""} ${className}`}>{children}</section>;
}

export function PanelTitle({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6"><div>{eyebrow && <div className="eyebrow mb-1.5 text-muted-foreground">{eyebrow}</div>}<h2 className="text-[14px] font-bold tracking-tight">{title}</h2></div>{right}</div>;
}

export function ShadowBadge({ className = "" }: { className?: string }) {
  return <span className={`inline-flex items-center gap-1.5 border border-accent/50 bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.11em] text-foreground ${className}`}><span className="h-1.5 w-1.5 rounded-full bg-accent" />Shadow Mode</span>;
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

export function MiniCandleChart({ candles, ntz, levels = [] }: { candles: Candle[]; ntz?: { status: "pending" | "inside" | "outside"; complete: boolean }; levels?: Array<{ name: string; price: number }> }) {
  if (!candles?.length) return <div className="flex h-[248px] items-center justify-center text-sm text-muted-foreground" data-testid="empty-candle-chart">No simulated candles yet.</div>;
  const width = 860, height = 248, padX = 22, padY = 22;
  const overlayPrices = levels.map((level) => level.price);
  const max = Math.max(...candles.map((c) => c.high), ...overlayPrices), min = Math.min(...candles.map((c) => c.low), ...overlayPrices);
  const scaleY = (v: number) => height - padY - ((v - min) / Math.max(max - min, .01)) * (height - padY * 2);
  const step = (width - padX * 2) / candles.length;
  const gridYs = [padY, height / 2, height - padY];
  return <div className="w-full overflow-x-auto px-4 pb-3" data-testid="chart-candles"><svg viewBox={`0 0 ${width} ${height}`} className="h-[248px] w-full min-w-[600px]" role="img" aria-label="Simulated five minute candle chart">
    {gridYs.map((y) => <line key={y} x1={0} x2={width} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray={y === height - padY ? "0" : "3 5"} />)}
    {ntz?.complete && <rect x={padX} y={scaleY(max)} width={Math.min(step * 3, width - padX * 2)} height={Math.max(scaleY(min) - scaleY(max), 1)} fill="hsl(var(--accent) / .08)" stroke="hsl(var(--accent) / .45)" strokeDasharray="4 4" />}
    {levels.slice(0, 5).map((level) => <g key={level.name}><line x1={padX} x2={width - padX} y1={scaleY(level.price)} y2={scaleY(level.price)} stroke="hsl(var(--accent) / .45)" strokeWidth="1" strokeDasharray="5 5" /><text x={width - padX - 4} y={scaleY(level.price) - 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="9" fontFamily="DM Mono">{level.name}</text></g>)}
    {candles.map((c, index) => { const x = padX + index * step + step / 2; const up = c.close >= c.open; const color = up ? "hsl(var(--positive))" : "hsl(var(--negative))"; const bodyTop = Math.min(scaleY(c.open), scaleY(c.close)); const bodyHeight = Math.max(Math.abs(scaleY(c.close) - scaleY(c.open)), 3); return <g key={`${c.time}-${index}`}><line x1={x} x2={x} y1={scaleY(c.high)} y2={scaleY(c.low)} stroke={color} strokeWidth="1.5" /><rect x={x - Math.max(step * .22, 3)} y={bodyTop} width={Math.max(step * .44, 6)} height={bodyHeight} rx="1" fill={color} /></g>; })}
    <text x="8" y={padY + 4} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="DM Mono">{max.toFixed(2)}</text>
    <text x="8" y={height - padY - 5} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="DM Mono">{min.toFixed(2)}</text>
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