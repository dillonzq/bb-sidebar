import { useProviders, useSidebarThreadSplit, useSidebarThreads } from "./bb-sdk";
import { useEffect, useId, useState, type ReactElement } from "react";
import { useBbNavigate, useRpc, useRealtime, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./contract";
import { PROJECT_ICONS_CHANNEL } from "./realtime-channels";
import { ThreadHoverCard } from "./components/ThreadHoverCard";
import { threadDisplayTitle } from "./inbox";
import { Icon, type IconName } from "./components/Icon";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusGlyph } from "./StatusGlyph";
import { useThreadWithDraft } from "./StatusSlot";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { OpenPortDetails } from "./OpenPorts";
import { ThreadPullRequestDetails } from "./ThreadPullRequests";
import { compareChildThreads, useChildThreadDisplay } from "./ChildThreadDisplay";
import { cn } from "./lib/utils";

// Match the composer's built-in labels; provider-specific labels take precedence.
const REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

export function ThreadDetailsTooltip({
  thread,
  disabled,
  children,
}: {
  thread: PluginSidebarThread;
  disabled: boolean;
  children: ReactElement;
}) {
  const { providers } = useProviders();
  const provider = providers.find((entry) => entry.id === thread.providerId);
  const { projects, threads } = useSidebarThreads();
  const navigate = useBbNavigate();
  const { call } = useRpc<typeof bbSidebarRpcContract>();
  const [iconRevision, setIconRevision] = useState(0);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setIconRevision((revision) => revision + 1);
  });
  const [open, setOpen] = useState(false);
  const [subthreadsExpanded, setSubthreadsExpanded] = useState(false);
  const subthreadsId = useId();
  const [execution, setExecution] = useState<{ model: string; modelDisplayName?: string; reasoningLevel: string }>({
    model: "Loading…",
    reasoningLevel: "",
  });
  const visible = open && !disabled;
  const modelLabel = execution.modelDisplayName || execution.model;
  const effortLabel =
    provider?.reasoningLevels?.find((level) => level.id === execution.reasoningLevel)?.label ??
    REASONING_LABELS[execution.reasoningLevel] ??
    execution.reasoningLevel;
  const modelIncludesReasoning = [execution.reasoningLevel, effortLabel].some(
    (label) =>
      label &&
      (modelLabel.toLowerCase().endsWith(` ${label.toLowerCase()}`) ||
        modelLabel.toLowerCase().endsWith(` (${label.toLowerCase()})`)),
  );
  const reasoningLabel = modelIncludesReasoning ? "" : effortLabel;
  const executionLabel = [modelLabel, reasoningLabel].filter(Boolean).join(" ");

  useEffect(() => {
    setSubthreadsExpanded(false);
    if (!visible) return;
    let cancelled = false;
    setExecution({ model: "Loading…", reasoningLevel: "" });
    void call("getThreadExecutionDetails", { threadId: thread.id }).then(
      (details) => {
        if (!cancelled) {
          setExecution(details ?? { model: "Not set", reasoningLevel: "" });
        }
      },
      () => {
        if (!cancelled) setExecution({ model: "Unavailable", reasoningLevel: "" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [call, thread.id, visible]);

  const { sort: childSort } = useChildThreadDisplay();
  const statusThread = useThreadWithDraft(thread);
  const project = projects.find((entry) => entry.id === thread.projectId);
  const isWorktree =
    thread.environment?.workspaceDisplayKind === "managed-worktree" ||
    thread.environment?.workspaceDisplayKind === "unmanaged-worktree";
  const status = thread.hasPendingInteraction ? "Needs you" : (statusThread.indicatorLabel ?? "Idle");
  const subthreads = visible
    ? threads
        .filter((child) => !child.isArchived && child.parentThreadId === thread.id && child.id !== thread.id)
        .sort(compareChildThreads(childSort))
    : [];
  const label = (
    <div className="flex flex-col gap-2">
      <div className="truncate text-xs font-semibold leading-4 text-popover-foreground">
        {threadDisplayTitle(thread)}
      </div>
      <div className="flex flex-col gap-1.5 text-xs leading-4 text-muted-foreground">
        {project ? (
          <div className="flex items-center gap-2">
            <ProjectFavicon src={projectIconUrl(project.id, iconRevision)} name={project.name} />
            <span className="truncate">
              <span className="sr-only">Project: </span>
              {project.name}
            </span>
          </div>
        ) : null}
        {thread.host ? <DetailRow icon="Computer" label="Machine" value={thread.host.name} /> : null}
        {thread.environment?.branchName ? (
          <DetailRow
            icon={isWorktree ? "FolderGit" : "GitBranch"}
            label={isWorktree ? "Worktree branch" : "Branch"}
            value={thread.environment.branchName}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            <ProviderGlyph
              providerId={thread.providerId}
              provider={provider ?? null}
              className="size-3.5 [&_span]:size-3.5"
            />
            {statusThread.indicator !== "none" ? (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-popover">
                <StatusGlyph indicator={statusThread.indicator} label={status} className="size-2.5" />
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate" title={executionLabel}>
            <span className="sr-only">Model: </span>
            {modelLabel}
            {reasoningLabel ? (
              <>
                {" "}
                <span className="sr-only">Reasoning: </span>
                {reasoningLabel}
              </>
            ) : null}
          </span>
        </div>
        <span className="sr-only">Status: {status}</span>
        {subthreads.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <button
              type="button"
              aria-expanded={subthreadsExpanded}
              aria-controls={subthreadsExpanded ? subthreadsId : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setSubthreadsExpanded((expanded) => !expanded);
              }}
              className="pointer-events-auto flex items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="Workflow" className="size-3.5 shrink-0" aria-hidden />
              <span>Subthreads ({subthreads.length})</span>
              <Icon
                name={subthreadsExpanded ? "ChevronUp" : "ChevronDown"}
                className="ml-auto size-3 shrink-0"
                aria-hidden
              />
            </button>
            {subthreadsExpanded ? (
              <ul
                id={subthreadsId}
                aria-label="Subthreads"
                className="pointer-events-auto flex max-h-[min(12rem,30dvh)] flex-col gap-1.5 overflow-y-auto"
              >
                {subthreads.map((child) => (
                  <li key={child.id} className="min-w-0 pl-5">
                    <SubthreadRow
                      thread={child}
                      onOpen={() => {
                        setOpen(false);
                        navigate.toThread(child.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <ThreadPullRequestDetails thread={thread} />
        <OpenPortDetails thread={thread} />
      </div>
    </div>
  );

  return (
    <ThreadHoverCard content={label} open={visible} onOpenChange={setOpen}>
      {children}
    </ThreadHoverCard>
  );
}

function SubthreadRow({ thread, onOpen }: { thread: PluginSidebarThread; onOpen: () => void }) {
  const { splitProps } = useSidebarThreadSplit(thread.id);
  const { providers } = useProviders();
  const provider = providers.find((entry) => entry.id === thread.providerId);
  const statusThread = useThreadWithDraft(thread);
  const status = thread.hasPendingInteraction ? "Needs you" : (statusThread.indicatorLabel ?? "Idle");
  return (
    <button
      type="button"
      aria-label={`Open subthread: ${threadDisplayTitle(thread)}`}
      draggable={false}
      onPointerDown={splitProps.onPointerDown}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        splitProps.onPointerDown ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      <ProviderGlyph
        providerId={thread.providerId}
        provider={provider ?? null}
        className="mt-px size-3.5 shrink-0 [&_span]:size-3.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{threadDisplayTitle(thread)}</span>
        <span className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
          <span className="truncate">
            {provider?.displayName ?? thread.providerId} · {status}
          </span>
          <StatusGlyph
            indicator={thread.hasPendingInteraction ? "waiting-for-input" : statusThread.indicator}
            label={null}
            className="size-2.5"
          />
        </span>
      </span>
    </button>
  );
}

function DetailRow({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate" title={value}>
        <span className="sr-only">{label}: </span>
        {value}
      </span>
    </div>
  );
}
