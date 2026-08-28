import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, BarChart3, BookOpen, ChevronRight, FileSearch, Gauge, Menu, Settings2, ShieldCheck, X } from "lucide-react";
import { SHADOW_MODE_LABEL } from "@/lib/shadow-mode";

const navItems = [
  { href: "/", label: "Cockpit", detail: "Decision surface", icon: Gauge },
  { href: "/journal", label: "Shadow journal", detail: "Review ledger", icon: BookOpen },
  { href: "/settings", label: "Risk guardrails", detail: "Rules of engagement", icon: Settings2 },
  { href: "/backtest", label: "Replay lab", detail: "Causal reports", icon: BarChart3 },
  { href: "/visual-review", label: "Visual review", detail: "Candle validation", icon: FileSearch },
];

export function LevelStoryShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="noise min-h-[100dvh] bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[238px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarBrand />
        <div className="mx-6 mt-8 flex items-center justify-between border-y border-sidebar-border py-3">
          <span className="eyebrow text-sidebar-foreground/45">Workspace</span>
          <span className="mono text-[10px] text-sidebar-foreground/40">SIM / 01</span>
        </div>
        <nav className="flex-1 px-3 py-4" aria-label="Main navigation">
          <div className="space-y-1">
            {navItems.map((item) => <NavItem key={item.href} item={item} active={location === item.href} />)}
          </div>
        </nav>
        <SafetyNote />
        <div className="border-t border-sidebar-border px-6 py-4">
          <div className="flex items-center justify-between text-[10px] text-sidebar-foreground/40">
            <span>LEVELSTORY / v0.4</span><Activity size={12} />
          </div>
        </div>
      </aside>

      {menuOpen && <button type="button" aria-label="Close navigation overlay" className="fixed inset-0 z-40 cursor-default bg-foreground/35 lg:hidden" onClick={closeMenu} data-testid="button-close-navigation-overlay" />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[276px] flex-col bg-sidebar text-sidebar-foreground transition-transform duration-300 lg:hidden ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between p-5"><SidebarBrand /><button type="button" onClick={closeMenu} className="rounded-md p-2 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label="Close navigation" data-testid="button-close-navigation"><X size={19} /></button></div>
        <nav className="px-3 py-5" aria-label="Mobile navigation">{navItems.map((item) => <div key={item.href} onClick={closeMenu}><NavItem item={item} active={location === item.href} /></div>)}</nav>
        <div className="mt-auto"><SafetyNote /><div className="border-t border-sidebar-border px-5 py-4 text-[10px] text-sidebar-foreground/40">No broker connection / no live orders</div></div>
      </aside>

      <div className="lg:pl-[238px]">
        <header className="sticky top-0 z-30 flex h-[62px] items-center justify-between border-b border-border/80 bg-background/92 px-4 backdrop-blur-md sm:px-7 lg:px-9">
          <button type="button" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-3 lg:flex"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--positive))]" /><span className="eyebrow text-muted-foreground">Focus session</span><span className="text-xs text-muted-foreground/70">/ pre-market simulation</span><span className="h-4 w-px bg-border" /><span className="mono text-[10px] text-muted-foreground/65">CAUSAL DATA ONLY</span></div>
          <div className="ml-auto flex items-center gap-3">
             <span className="flex max-w-[min(70vw,320px)] items-center gap-2 border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[.1em] text-foreground sm:max-w-none sm:text-[10px]" data-testid="banner-shadow-mode"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />{SHADOW_MODE_LABEL}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground" aria-label="Trader profile">LM</span>
          </div>
        </header>
        <main className="min-h-[calc(100dvh-62px)]">{children}</main>
      </div>
    </div>
  );
}

function SidebarBrand() {
  return <Link href="/" className="flex items-center gap-3 px-6 pt-6" data-testid="link-brand">
    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"><span className="display text-lg font-bold">L</span></span>
    <span><span className="block text-[15px] font-extrabold tracking-tight">LevelStory</span><span className="eyebrow text-sidebar-foreground/45">discipline lab</span></span>
  </Link>;
}

function SafetyNote() {
  return <div className="m-3 rounded-md border border-sidebar-border bg-sidebar-accent/70 p-4">
     <div className="mb-3 flex items-center gap-2 text-sidebar-primary"><ShieldCheck size={15} /><span className="eyebrow">Safe by design</span></div>
    <p className="text-xs leading-5 text-sidebar-foreground/65">A quiet place to decide. No broker connection, no live orders, no execution path.</p>
     <div className="mt-4 flex items-center gap-2 text-[10px] font-semibold text-sidebar-foreground/50" data-testid="text-shadow-mode-safety"><span className="h-1.5 w-1.5 rounded-full bg-sidebar-primary" />{SHADOW_MODE_LABEL}</div>
  </div>;
}

function NavItem({ item, active }: { item: typeof navItems[number]; active: boolean }) {
  const Icon = item.icon;
  return <Link href={item.href} className={`group flex items-center gap-3 rounded-md px-3 py-3 transition-colors ${active ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(" ", "-")}`}>
    <Icon size={17} strokeWidth={active ? 2.4 : 1.8} />
    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.label}</span><span className={`block text-[10px] ${active ? "text-sidebar-primary-foreground/65" : "text-sidebar-foreground/40"}`}>{item.detail}</span></span>
    {active && <ChevronRight size={14} />}
  </Link>;
}