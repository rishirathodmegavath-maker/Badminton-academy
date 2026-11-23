"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, LogOut, Menu, ShieldCheck, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { initials, monogramColours } from "./brand";
import { DRAWER_QUERY } from "./breakpoints";
import { useFocusTrap } from "./use-focus-trap";

export type ShellItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Real URL. When omitted the item is a button handled by `onSelect` (family portal sections). */
  href?: string;
  /** A short text chip such as "SOON". Text, never colour alone. */
  badge?: string;
  /**
   * Makes the item a collapsible group: the item itself is a button that opens and closes this list of sub-items. Each
   * sub-item is a normal item (a real link, or a button handled by `onSelect`). A group has no page of its own.
   */
  children?: ShellItem[];
};

export type ShellProps = {
  product: string;
  homeHref: string;
  academy: { name: string; accent?: string | null; subtitle?: string; logo?: string | null };
  user: { name: string; role: string };
  items: ShellItem[];
  /**
   * Optional primary items repeated as a bottom bar on phones (below 768 px), for a portal whose few main sections
   * are used one-handed (UX N3). They are the same items, chosen the same way; the menu stays available.
   */
  bottomItems?: ShellItem[];
  activeKey: string;
  /** Called for button items; link items navigate through the router. */
  onSelect?: (key: string) => void;
  /** Return false to stop navigating or signing out (for example unsaved changes the person chose to keep). */
  guard?: (intent?: "navigate" | "sign-out") => boolean;
  breadcrumb: string[];
  headerExtras?: ReactNode;
  mainClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
};

const STORE = "sportozen.sidebar";
/** A stored role read as words, in sentence case, with underscores shown as spaces (UX-D5). Display only. */
const words = (value: string) => {
  const text = value.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function useDrawerMode() {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(DRAWER_QUERY);
    const sync = () => setDrawer(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return drawer;
}

export async function signOut() {
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } finally {
    window.location.assign("/login");
  }
}

export function AppShell({
  product,
  homeHref,
  academy,
  user,
  items,
  bottomItems,
  activeKey,
  onSelect,
  guard,
  breadcrumb,
  headerExtras,
  mainClassName,
  footer,
  children,
}: ShellProps) {
  const drawerMode = useDrawerMode();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  /** Which collapsible groups of the menu are open (all start closed). */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const sidebar = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const accountRoot = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const previousKey = useRef(activeKey);
  const open = drawerMode && drawerOpen;
  const compact = collapsed && !drawerMode;

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORE) === "collapsed");
    } catch {
      /* storage unavailable: expanded */
    }
  }, []);
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORE, next ? "collapsed" : "expanded");
    } catch {
      /* ignore */
    }
  }

  function toggleGroup(key: string) {
    // In the icon-only sidebar there is no room for a list: the first press widens the sidebar and opens the group.
    if (compact) {
      toggleCollapsed();
      setOpenGroups((now) => ({ ...now, [key]: true }));
      return;
    }
    setOpenGroups((now) => ({ ...now, [key]: !now[key] }));
  }

  // A leaving drawer must not stay open when the window grows or a page is chosen.
  useEffect(() => {
    if (!drawerMode) setDrawerOpen(false);
  }, [drawerMode]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useFocusTrap(open, sidebar, closeDrawer);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // After choosing a page: tell screen readers and move focus to the new page (not on first load).
  useEffect(() => {
    // Only a real change of page (not the first render, nor React strict mode running the effect twice).
    if (previousKey.current === activeKey) return;
    previousKey.current = activeKey;
    const current = items.find((i) => i.key === activeKey);
    setAnnounce(current ? `${current.label} page` : "");
    main.current?.focus({ preventScroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Account menu: closes on Escape (focus returns to its button) and on a click or focus outside it.
  useEffect(() => {
    if (!accountOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountOpen(false);
        accountButton.current?.focus();
      }
    }
    function onPointer(event: Event) {
      if (!accountRoot.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onPointer);
    };
  }, [accountOpen]);

  const monogram = monogramColours(academy.accent);
  const personInitial = (user.name.trim()[0] ?? "?").toUpperCase();

  function choose(event: React.MouseEvent, item: ShellItem) {
    if (guard && !guard()) {
      event.preventDefault();
      return;
    }
    if (!item.href) {
      event.preventDefault();
      onSelect?.(item.key);
    }
    setDrawerOpen(false);
  }
  async function leave() {
    if (guard && !guard("sign-out")) return;
    await signOut();
  }
  // Whether the person belongs to more than one academy (so "Switch academy" is worth showing). Asked once, when the
  // account menu is first opened; the server answers with the person's own memberships only.
  const [academyCount, setAcademyCount] = useState(0);
  useEffect(() => {
    if (!accountOpen || academyCount) return;
    let live = true;
    fetch("/api/auth/account/academies", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j && Array.isArray(j.academies)) setAcademyCount(j.academies.length);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accountOpen, academyCount]);

  return (
    <div
      className="ax-shell"
      data-collapsed={compact ? "true" : "false"}
      data-drawer={drawerMode ? "true" : "false"}
      data-open={open ? "true" : "false"}
      data-bottom-bar={bottomItems?.length ? "true" : "false"}
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {open && <div className="ax-backdrop" onClick={closeDrawer} aria-hidden="true" />}
      <aside
        id="ax-sidebar"
        ref={sidebar}
        className="ax-sidebar"
        aria-label={open ? "Navigation drawer" : "Sidebar"}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        inert={drawerMode && !drawerOpen}
        tabIndex={-1}
      >
        <div className="ax-sidebar-top">
          <Link className="ax-wordmark" href={homeHref} onClick={(e) => guard && !guard() && e.preventDefault()}>
            {/* The Sportozen platform symbol, as in the Football app. Decorative: the wordmark beside it carries the name. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ax-symbol" src="/brand/sportozen-logo.png" alt="" aria-hidden="true" width={259} height={313} />
            <span className="ax-wordmark-text">
              <span className="ax-wordmark-name">Sportozen</span>
              <span className="ax-wordmark-product">{product}</span>
            </span>
          </Link>
          {drawerMode && (
            <button className="ax-icon-button ax-on-dark" aria-label="Close navigation" onClick={closeDrawer}>
              <X size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="ax-academy" title={compact ? academy.name : undefined}>
          {academy.logo ? (
            // The academy's own logo (a small PNG served to its members only).
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ax-logo" src={academy.logo} alt="" aria-hidden="true" />
          ) : (
            <span className="ax-monogram" style={monogram} aria-hidden="true">
              {initials(academy.name)}
            </span>
          )}
          <span className="ax-academy-text">
            <strong>{academy.name}</strong>
            {academy.subtitle && <small>{academy.subtitle}</small>}
          </span>
        </div>
        <nav aria-label="Main navigation" className="ax-nav">
          <ul>
            {items.map((item) => {
              const Icon = item.icon;
              const active = item.key === activeKey;
              if (item.children?.length) {
                const groupOpen = !!openGroups[item.key] && !compact;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="ax-nav-item ax-nav-group"
                      aria-expanded={groupOpen}
                      aria-controls={`ax-group-${item.key}`}
                      title={compact ? item.label : undefined}
                      onClick={() => toggleGroup(item.key)}
                    >
                      <Icon size={19} aria-hidden="true" />
                      <span className="ax-nav-label">{item.label}</span>
                      <ChevronDown className="ax-group-chevron" size={16} aria-hidden="true" />
                    </button>
                    <ul id={`ax-group-${item.key}`} className="ax-subnav" hidden={!groupOpen}>
                      {item.children.map((child) => {
                        const ChildIcon = child.icon;
                        const childContent = (
                          <>
                            <ChildIcon size={16} aria-hidden="true" />
                            <span className="ax-nav-label">{child.label}</span>
                          </>
                        );
                        return (
                          <li key={child.key}>
                            {child.href ? (
                              <Link href={child.href} className="ax-nav-item ax-subnav-item" onClick={(e) => choose(e, child)}>
                                {childContent}
                              </Link>
                            ) : (
                              <button type="button" className="ax-nav-item ax-subnav-item" onClick={(e) => choose(e, child)}>
                                {childContent}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              }
              const content = (
                <>
                  <Icon size={19} aria-hidden="true" />
                  <span className="ax-nav-label">{item.label}</span>
                  {item.badge && <span className="ax-chip">{item.badge}</span>}
                </>
              );
              return (
                <li key={item.key}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="ax-nav-item"
                      aria-current={active ? "page" : undefined}
                      title={compact ? item.label : undefined}
                      onClick={(e) => choose(e, item)}
                    >
                      {content}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="ax-nav-item"
                      aria-current={active ? "page" : undefined}
                      title={compact ? item.label : undefined}
                      onClick={(e) => choose(e, item)}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ax-sidebar-bottom">
          <a className="ax-account-link" href="/account" title={compact ? "Account security" : undefined}>
            <span className="ax-avatar" aria-hidden="true">
              {personInitial}
            </span>
            <span className="ax-account-text">
              <strong>{user.name}</strong>
              <small>{words(user.role).replace("Adult player", "Player")} · Account security</small>
            </span>
          </a>
          <button type="button" className="ax-nav-item ax-signout" onClick={() => void leave()} title={compact ? "Sign out" : undefined}>
            <LogOut size={19} aria-hidden="true" />
            <span className="ax-nav-label">Sign out</span>
          </button>
          {!drawerMode && (
            <button
              type="button"
              className="ax-nav-item ax-collapse"
              aria-expanded={!collapsed}
              aria-controls="ax-sidebar"
              onClick={toggleCollapsed}
              title={compact ? "Expand sidebar" : undefined}
            >
              {collapsed ? <ChevronRight size={19} aria-hidden="true" /> : <ChevronLeft size={19} aria-hidden="true" />}
              <span className="ax-nav-label">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
            </button>
          )}
        </div>
      </aside>

      <div className="ax-workspace">
        <header className="ax-header" inert={open}>
          {drawerMode && (
            <button
              type="button"
              className="ax-icon-button"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls="ax-sidebar"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={21} aria-hidden="true" />
            </button>
          )}
          <nav aria-label="Breadcrumb" className="ax-breadcrumb">
            <ol>
              {breadcrumb.map((part, i) => (
                <li key={part + i} aria-current={i === breadcrumb.length - 1 ? "page" : undefined}>
                  {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
                  {i === breadcrumb.length - 1 ? <strong>{part}</strong> : <span>{part}</span>}
                </li>
              ))}
            </ol>
          </nav>
          <div className="ax-header-right">
            {headerExtras}
            <div className="ax-account" ref={accountRoot}>
              <button
                type="button"
                ref={accountButton}
                className="ax-account-button"
                aria-expanded={accountOpen}
                aria-controls="ax-account-panel"
                onClick={() => setAccountOpen((v) => !v)}
              >
                <span className="ax-avatar" aria-hidden="true">
                  {personInitial}
                </span>
                <span className="ax-account-name">{user.name}</span>
                <ChevronDown size={15} aria-hidden="true" />
                <span className="sr-only">Account menu</span>
              </button>
              {accountOpen && (
                <div id="ax-account-panel" className="ax-account-panel" role="group" aria-label="Account">
                  <p>
                    <strong>{user.name}</strong>
                    <small>
                      {words(user.role)} · {academy.name}
                    </small>
                  </p>
                  {academyCount > 1 && (
                    <button
                      type="button"
                      className="ax-menu-item"
                      onClick={() => {
                        if (guard && !guard("navigate")) return;
                        window.location.assign("/academies?switch=1");
                      }}
                    >
                      <ArrowLeftRight size={17} aria-hidden="true" />
                      Switch academy
                    </button>
                  )}
                  <a href="/account" className="ax-menu-item">
                    <ShieldCheck size={17} aria-hidden="true" />
                    Account security
                  </a>
                  <button type="button" className="ax-menu-item" onClick={() => void leave()}>
                    <LogOut size={17} aria-hidden="true" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main" ref={main} tabIndex={-1} className={`main-content ax-main ${mainClassName ?? ""}`} inert={open}>
          {children}
          {footer}
        </main>
      </div>
      {bottomItems && bottomItems.length > 0 && (
        <nav aria-label="Quick navigation" className="ax-bottom-bar" inert={open}>
          <ul>
            {bottomItems.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className="ax-bottom-item"
                    aria-current={item.key === activeKey ? "page" : undefined}
                    onClick={(e) => choose(e, item)}
                  >
                    <Icon size={22} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
