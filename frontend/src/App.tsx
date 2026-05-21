import { useEffect, useState, useCallback, useMemo } from "react";
import {
  WebhooksLogo,
  Robot,
  ChatCircleText,
  ShieldCheck,
  Key,
  Network,
  ArrowSquareOut,
  BookOpen,
  List as ListIcon,
} from "@phosphor-icons/react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { CloudflareLogo } from "@cloudflare/kumo/components/cloudflare-logo";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Banner } from "@cloudflare/kumo/components/banner";
import { ContainersIcon } from "./components/icons/ContainersIcon";
import { api, type ConfigResponse } from "./api";
import { claudeEnvironmentUrl, claudePlatformDashboardUrl } from "./utils";
import {
  API_REFERENCE_URL,
  PATHS,
  navIdForPath,
  pathForNav,
  routeTo,
  type NavId,
} from "./routes";
import { EnvironmentsView } from "./views/EnvironmentsView";
import { EnvironmentDetailView } from "./views/EnvironmentDetailView";
import { WebhookEventsView } from "./views/WebhookEventsView";
import { AgentsView } from "./views/AgentsView";
import { AgentDetailView } from "./views/AgentDetailView";
import { AgentFormView } from "./views/AgentFormView";
import { SessionsView } from "./views/SessionsView";
import { SessionDetailView } from "./views/SessionDetailView";
import { SessionFormView } from "./views/SessionFormView";
import { EgressView } from "./views/EgressView";
import { SecretsView } from "./views/SecretsView";
import { VpcView } from "./views/VpcView";
import { DocView } from "./views/DocView";
import { DOCS } from "./views/docs/registry";
import { ToastProvider } from "./toasts";

// Discriminated union representing every navigable destination in the app.
// View components still take a `navigate(view)` callback prop — we keep that
// shape so existing calls don't need to learn about react-router primitives.
// The actual URL update happens in `useViewNavigate` below.
export type View =
  | { kind: "environments" }
  | { kind: "env-detail"; sessionId: string }
  | { kind: "events" }
  | { kind: "agents" }
  | { kind: "agent-detail"; agentId: string }
  | { kind: "agent-form"; agentId?: string }
  | { kind: "sessions" }
  | { kind: "session-detail"; sessionId: string }
  | { kind: "session-form" }
  | { kind: "egress" }
  | { kind: "secrets" }
  | { kind: "vpc" }
  | { kind: "doc"; slug: string };

type NavItem = { id: NavId; label: string; icon: typeof ShieldCheck };
type NavGroup = {
  label: string;
  items: NavItem[];
  // Collapsible groups render with `Sidebar.GroupLabel` as the trigger
  // and `Sidebar.GroupContent` wrapping the menu — required for the
  // chevron + animated expand/collapse Kumo provides out of the box.
  collapsible?: boolean;
  defaultOpen?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Cloudflare",
    items: [
      { id: "environments", label: "Sandboxes", icon: ContainersIcon },
      { id: "egress", label: "Egress Policies", icon: ShieldCheck },
      { id: "secrets", label: "Secrets", icon: Key },
      { id: "vpc", label: "VPC + Mesh", icon: Network },
    ],
  },
  {
    label: "Claude Platform",
    items: [
      { id: "sessions", label: "Sessions", icon: ChatCircleText },
      { id: "agents", label: "Agents", icon: Robot },
      { id: "events", label: "Webhook Events", icon: WebhooksLogo },
    ],
  },
  {
    label: "Documentation",
    // Everything under one collapsible section, closed by default. The
    // ordering puts About + Architecture first (orientation reading),
    // then the recipes from the docs registry, then the generated API
    // Reference. Each doc uses its short `sidebarTitle` because sidebar
    // entries truncate when the column is narrow.
    collapsible: true,
    defaultOpen: false,
    items: [
      ...docNavItems(["about", "architecture"]),
      ...DOCS.filter(
        (d) => d.slug !== "about" && d.slug !== "architecture",
      ).map((d) => ({
        id: `doc:${d.slug}` as NavId,
        label: d.sidebarTitle,
        icon: d.icon,
      })),
      { id: "api-docs", label: "API Reference", icon: BookOpen },
    ],
  },
];

// Build sidebar items in a specific slug order, looking each up in the
// docs registry. Skips slugs that don't resolve so a typo doesn't crash
// the sidebar.
function docNavItems(slugs: string[]): NavItem[] {
  return slugs.flatMap((slug) => {
    const doc = DOCS.find((d) => d.slug === slug);
    if (!doc) return [];
    return [
      {
        id: `doc:${doc.slug}` as NavId,
        label: doc.sidebarTitle,
        icon: doc.icon,
      },
    ];
  });
}

// Bridges our internal View union to react-router's `useNavigate`. View
// components keep calling `navigate({ kind: ..., ... })` and this turns it
// into a real URL push. Returning a stable callback also keeps `useEffect`
// dependency arrays well-behaved.
export function useViewNavigate(): (view: View) => void {
  const nav = useNavigate();
  return useCallback(
    (view: View) => {
      nav(routeTo(view));
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    },
    [nav],
  );
}

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ToastProvider>
  );
}

function AppShell() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((err: Error) => setConfigError(err.message));
  }, []);

  const activeNav = useMemo(
    () => navIdForPath(location.pathname),
    [location.pathname],
  );

  const navigateTo = useCallback(
    (id: NavId) => {
      // The API Reference lives outside the SPA (served as a static
      // /redoc.html). Trigger a real browser navigation so the back
      // button returns to whatever dashboard page the user came from
      // without an iframe-history detour.
      if (id === "api-docs") {
        if (typeof window !== "undefined") {
          window.location.assign(API_REFERENCE_URL);
        }
        return;
      }
      navigate(pathForNav(id));
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    },
    [navigate],
  );

  return (
    <Sidebar.Provider defaultOpen collapsible="icon">
      <Sidebar>
        <Sidebar.Header>
          <div className="sidebar-account">
            <CloudflareLogo variant="glyph" />
            <span className="sidebar-account-name">
              Cloudflare Claude Agents
            </span>
          </div>
        </Sidebar.Header>

        <Sidebar.Content>
          {NAV_GROUPS.map((group) => (
            <NavGroupSection
              key={group.label}
              group={group}
              activeNav={activeNav}
              navigateTo={navigateTo}
            />
          ))}
        </Sidebar.Content>

        <Sidebar.Footer>
          <Sidebar.Trigger />
        </Sidebar.Footer>
      </Sidebar>

      <main className="app-main">
        <TopBar config={config} configError={configError} />
        <div className="app-page">
          <SetupBanner config={config} />
          <SnapshotsBanner config={config} />
          <AppRoutes />
        </div>
      </main>
    </Sidebar.Provider>
  );
}

function TopBar({
  config,
  configError,
}: {
  config: ConfigResponse | null;
  configError: string | null;
}) {
  const envId = config?.environmentId;
  const errLabel = configError ? "error" : "—";
  return (
    <div className="app-topbar">
      <MobileSidebarTrigger />
      <div className="app-topbar-meta">
        <LinkButton
          variant="ghost"
          size="sm"
          icon={ArrowSquareOut}
          href={claudePlatformDashboardUrl()}
          external
          className="topbar-platform-link"
        >
          Claude Platform
        </LinkButton>
        <LinkButton
          variant="ghost"
          size="sm"
          icon={ArrowSquareOut}
          href="https://dash.cloudflare.com/"
          external
          className="topbar-platform-link"
        >
          Cloudflare Dashboard
        </LinkButton>
        <div className="topbar-cell">
          <span className="topbar-cell-label">Environment</span>
          {envId ? (
            <a
              className="topbar-cell-value mono"
              href={claudeEnvironmentUrl(envId)}
              target="_blank"
              rel="noreferrer"
              title={`Open ${envId} in Claude Platform`}
            >
              {envId}
            </a>
          ) : (
            <span className="topbar-cell-value mono">{errLabel}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// Renders a single sidebar group. For collapsible groups we keep a small
// piece of local state tracking whether the user has explicitly toggled
// it; that toggle wins for normal navigation, but if the active page is
// inside the group we force it open so the highlighted item is visible
// (e.g. landing on a Cookbook doc via deep link or refresh).
function NavGroupSection({
  group,
  activeNav,
  navigateTo,
}: {
  group: NavGroup;
  activeNav: NavId | null;
  navigateTo: (id: NavId) => void;
}) {
  const containsActive = useMemo(
    () => activeNav != null && group.items.some((i) => i.id === activeNav),
    [group, activeNav],
  );

  const [userOpen, setUserOpen] = useState<boolean>(group.defaultOpen ?? true);
  const open = containsActive ? true : userOpen;

  const menu = (
    <Sidebar.Menu>
      {group.items.map((item) => (
        <Sidebar.MenuButton
          key={item.id}
          icon={item.icon}
          active={activeNav === item.id}
          tooltip={item.label}
          onClick={() => navigateTo(item.id)}
        >
          {item.label}
        </Sidebar.MenuButton>
      ))}
    </Sidebar.Menu>
  );

  if (!group.collapsible) {
    return (
      <Sidebar.Group>
        <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
        {menu}
      </Sidebar.Group>
    );
  }

  return (
    <Sidebar.Group collapsible open={open} onOpenChange={setUserOpen}>
      <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
      <Sidebar.GroupContent>{menu}</Sidebar.GroupContent>
    </Sidebar.Group>
  );
}

function MobileSidebarTrigger() {
  // Visible on mobile only — toggles the sidebar dialog sheet that Kumo
  // renders when the viewport is below the sidebar breakpoint.
  const { isMobile, toggleSidebar } = useSidebar();
  if (!isMobile) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={ListIcon}
      aria-label="Open navigation"
      onClick={toggleSidebar}
    />
  );
}

function SetupBanner({ config }: { config: ConfigResponse | null }) {
  if (!config || !config.missing || config.missing.length === 0) return null;
  return (
    <Banner
      variant="alert"
      title="Finish setup before creating sandboxes"
      description={
        <span>
          {config.missing.map((k, i) => (
            <span key={k}>
              <code>{k}</code>
              {i < config.missing.length - 1 ? ", " : ""}
            </span>
          ))}{" "}
          {config.missing.length === 1 ? "is" : "are"} not set. Add{" "}
          {config.missing.length === 1 ? "it" : "them"} to{" "}
          <code>.dev.vars</code> for local development, or run{" "}
          <code>npx wrangler secret put NAME</code> for production. See the{" "}
          <a
            href="https://github.com/cloudflare/claude-managed-agents#onboarding-guide"
            target="_blank"
            rel="noreferrer"
          >
            Onboarding Guide
          </a>{" "}
          for full setup instructions.
        </span>
      }
    />
  );
}

// Warn when the BACKUP_BUCKET R2 binding is missing. Without it,
// MicroVM `/workspace` is silently discarded on every container
// hibernation — long-running tasks lose state. Isolate sessions
// persist via DO SQLite and aren't affected, so we skip the banner
// on deployments where no agent uses the MicroVM backend.
function SnapshotsBanner({ config }: { config: ConfigResponse | null }) {
  if (!config?.capabilities) return null;
  if (config.capabilities.snapshots) return null;
  // `hasMicrovmAgents` defaults to true on older worker deploys that
  // don't emit the flag, so legacy behaviour (always warn) is preserved.
  if (config.capabilities.hasMicrovmAgents === false) return null;
  return (
    <Banner
      variant="alert"
      title="Sandbox snapshots are disabled"
      description={
        <span>
          The <code>BACKUP_BUCKET</code> R2 binding is not configured. MicroVM
          sessions will lose their <code>/workspace</code> on container
          hibernation. Run{" "}
          <code>
            npx wrangler r2 bucket create claude-managed-agents-snapshots
          </code>{" "}
          (and set the R2 access-key secrets for production) — see the README's
          onboarding checklist (step 4).
        </span>
      }
    />
  );
}

// Each route component pulls URL params via `useParams` and hands them to
// the existing view component. The view continues to use a `navigate(view)`
// callback to move around — adapted to a real URL push by `useViewNavigate`.
function EnvironmentsRoute() {
  return <EnvironmentsView navigate={useViewNavigate()} />;
}

function EnvironmentDetailRoute() {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  return (
    <EnvironmentDetailView sessionId={sessionId} navigate={useViewNavigate()} />
  );
}

function AgentsRoute() {
  return <AgentsView navigate={useViewNavigate()} />;
}

function AgentDetailRoute() {
  const { agentId = "" } = useParams<{ agentId: string }>();
  return <AgentDetailView agentId={agentId} navigate={useViewNavigate()} />;
}

function AgentFormRoute() {
  // /agents/new and /agents/:agentId/edit both render the form. The presence
  // of an :agentId param flips it into edit mode.
  const { agentId } = useParams<{ agentId?: string }>();
  return <AgentFormView agentId={agentId} navigate={useViewNavigate()} />;
}

function SessionsRoute() {
  return <SessionsView navigate={useViewNavigate()} />;
}

function SessionDetailRoute() {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  return (
    <SessionDetailView sessionId={sessionId} navigate={useViewNavigate()} />
  );
}

function SessionFormRoute() {
  return <SessionFormView navigate={useViewNavigate()} />;
}

function DocRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <DocView slug={slug} />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={PATHS.environments} replace />} />
      <Route path={PATHS.environments} element={<EnvironmentsRoute />} />
      <Route path={PATHS.envDetail} element={<EnvironmentDetailRoute />} />
      <Route path={PATHS.events} element={<WebhookEventsView />} />
      <Route path={PATHS.agents} element={<AgentsRoute />} />
      <Route path={PATHS.agentNew} element={<AgentFormRoute />} />
      <Route path={PATHS.agentDetail} element={<AgentDetailRoute />} />
      <Route path={PATHS.agentEdit} element={<AgentFormRoute />} />
      <Route path={PATHS.sessions} element={<SessionsRoute />} />
      <Route path={PATHS.sessionNew} element={<SessionFormRoute />} />
      <Route path={PATHS.sessionDetail} element={<SessionDetailRoute />} />
      <Route path={PATHS.egress} element={<EgressView />} />
      <Route path={PATHS.secrets} element={<SecretsView />} />
      <Route path={PATHS.vpc} element={<VpcView />} />
      <Route path={PATHS.doc} element={<DocRoute />} />
      {/* The API Reference (/redoc.html) is served as a static asset
          and reached via a top-level browser navigation from the
          sidebar — it's not a SPA route. */}
      <Route path="*" element={<Navigate to={PATHS.environments} replace />} />
    </Routes>
  );
}
