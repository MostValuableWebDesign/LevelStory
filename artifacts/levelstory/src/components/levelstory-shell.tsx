import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, BookOpen, ChevronRight, Gauge, Menu, Settings2, ShieldCheck, X } from "lucide-react";

const navItems = [
  { href: "/", label: "Cockpit", detail: "Today", icon: Gauge },
  { href: "/journal", label: "Shadow journal", detail: "Review only", icon: BookOpen },
  { href: "/settings", label: "Risk guardrails", detail: "Your rules", icon: Settings2 },
];

export function LevelStoryShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="noise min-h-[100dvh] bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarBrand />
        <nav className="flex-1 px-3 py-8" aria-label="Main navigation">
          <div className="eyebrow mb-3 px-3 text-sidebar-foreground/45">Workspace</div>
          <div className="space-y-1">
            {navItems.map((item) => <NavItem key={item.href} item={item} active={location === item.href} />)}
          </div>
        </nav>
        <div className="m-3 rounded-xl border border-sidebar-border bg-sidebar-accent/70 p-4">
          <div className="mb-3 flex items-center gap-2 text-sidebar-primary">
            <ShieldCheck size={15} />
            <span className="eyebrow">Safe by design</span>
          </div>
          <p className="text-xs leading-5 text-sidebar-foreground/65">No broker connection. No live orders. Just reps for your discipline.</p>
          <div className="mt-4 flex items-center gap-2 text-[10px] text-sidebar-foreground/45">
            <span className="h-1.5 w-1.5 rounded-full bg-sidebar-primary" />
            Shadow mode active
          </div>
        </div>
        <div className="border-t border-sidebar-border px-6 py-4">
          <div className="flex items-center justify-between text-[10px] text-sidebar-foreground/45">
            <span>LEVELSTORY / v0.4</span><Activity size={12} />
          </div>
        </div>
      </aside>

      {menuOpen && <div className="fixed inset-0 z-40 bg-foreground/30 lg:hidden" onClick={closeMenu} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[270px] flex-col bg-sidebar text-sidebar-foreground transition-transform duration-300 lg:hidden ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between p-5"><SidebarBrand /><button type="button" onClick={closeMenu} className="text-sidebar-foreground/60" aria-label="Close navigation" data-testid="button-close-navigation"><X size={19} /></button></div>
        <nav className="px-3 py-5">{navItems.map((item) => <div key={item.href} onClick={closeMenu}><NavItem item={item} active={location === item.href} /></div>)}</nav>
        <div className="mt-auto m-3 rounded-xl border border-sidebar-border bg-sidebar-accent/70 p-4 text-xs leading-5 text-sidebar-foreground/65">Shadow mode active. This workspace cannot place orders.</div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-30 flex h-[68px] items-center justify-between border-b border-border/70 bg-background/90 px-5 backdrop-blur-md sm:px-8 lg:px-10">
          <button type="button" className="rounded-lg p-2 text-muted-foreground hover:bg-muted lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-2 lg:flex"><span className="h-2 w-2 rounded-full bg-accent" /><span className="eyebrow text-muted-foreground">Focus session / pre-market</span></div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden rounded-full border border-accent/40 bg-accent/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.14em] text-foreground sm:inline-flex">Shadow Mode</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">LM</span>
          </div>
        </header>
        <main className="min-h-[calc(100dvh-68px)]">{children}</main>
      </div>
    </div>
  );
}

function SidebarBrand() {
  return <Link href="/" className="flex items-center gap-3 px-6 pt-7" data-testid="link-brand">
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><span className="display text-lg font-bold">L</span></span>
    <span><span className="block text-[15px] font-extrabold tracking-tight">LevelStory</span><span className="eyebrow text-sidebar-foreground/45">discipline lab</span></span>
  </Link>;
}

function NavItem({ item, active }: { item: typeof navItems[number]; active: boolean }) {
  const Icon = item.icon;
  return <Link href={item.href} className={`group flex items-center gap-3 rounded-lg px-3 py-3 transition-colors ${active ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(" ", "-")}`}>
    <Icon size={17} strokeWidth={active ? 2.4 : 1.8} />
    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.label}</span><span className={`block text-[10px] ${active ? "text-sidebar-primary-foreground/60" : "text-sidebar-foreground/40"}`}>{item.detail}</span></span>
    {active && <ChevronRight size={14} />}
  </Link>;
}