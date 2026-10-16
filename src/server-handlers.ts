import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle } from "./server-lifecycle";
import type { createThreadPortActions } from "./thread-ports";
import type { createServerProjectIcons } from "./server-project-icons";
import type { createServerProjectColors } from "./server-project-colors";
import type { createServerProjectManagement } from "./server-project-management";
import type { createServerSettleActions } from "./server-settle-actions";
import type { createServerSettings } from "./server-settings";
import type { createServerPolicy } from "./server-policy";
import type { createServerSettleCleanup } from "./server-settle-cleanup";
import type { createPortDiscovery } from "./port-discovery";
import type { createThreadPullRequests } from "./thread-pull-requests";
import type { createTitleRegenerator } from "./regenerate-title";
import { SIDEBAR_SETTINGS_CHANNEL, INBOX_ORDER_CHANNEL } from "./contract";
import { runThreadTasks } from "./thread-tasks";

export function createServerHandlers(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  settings: Awaited<ReturnType<typeof createServerSettings>>,
  policy: ReturnType<typeof createServerPolicy>,
  cleanup: ReturnType<typeof createServerSettleCleanup>,
  threadPortActions: ReturnType<typeof createThreadPortActions>,
  getOpenPorts: ReturnType<typeof createPortDiscovery>,
  threadPullRequests: ReturnType<typeof createThreadPullRequests>,
  regenerateTitle: ReturnType<typeof createTitleRegenerator>,
  modules: {
    icons: ReturnType<typeof createServerProjectIcons>;
    colors: ReturnType<typeof createServerProjectColors>;
    projects: ReturnType<typeof createServerProjectManagement>;
    settle: ReturnType<typeof createServerSettleActions>;
  },
) {
  const { readSidebarSettings, writeSidebarSettings } = settings;
  const { evaluatePolicies } = policy;
  const { reclaimThreadResources } = cleanup;
  const { readOne, readAll, withPinParentChange, write, clear, readInboxOrder, replaceInboxOrder } = lifecycle;

  const handlers = {
    getOpenPorts,
    getThreadPorts: threadPortActions.getThreadPorts,
    getThreadPullRequests: threadPullRequests.getThreadPullRequests,
    async closeThreadPorts(input) {
      if (readOne(input.threadId)?.settledOverride !== "settled") {
        throw new Error("Thread is no longer settled");
      }
      try {
        return await threadPortActions.closeThreadPorts(input);
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async stopWorkspacePort({ threadId, port }) {
      try {
        return await threadPortActions.closeThreadPorts({ threadId, ports: [port], scope: "workspace" });
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async getThreadExecutionDetails({ threadId }) {
      const options = await ctx.bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (!options) return null;
      const details = { model: options.model, reasoningLevel: options.reasoningLevel };
      try {
        const thread = await ctx.bb.sdk.threads.get({ threadId });
        if (!thread.environmentId) return details;
        const catalog = await ctx.bb.sdk.providers.models({
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        });
        const models = [...catalog.models, ...catalog.selectedOnlyModels];
        const model =
          models.find((entry) => entry.id === options.model) ?? models.find((entry) => entry.model === options.model);
        const modelDisplayName = model?.displayName.trim();
        return modelDisplayName ? { ...details, modelDisplayName } : details;
      } catch {
        // Offline hosts and unavailable provider catalogs must still show execution details.
        return details;
      }
    },
    async setThreadParent({ threadId, parentThreadId }) {
      return withPinParentChange(threadId, async () => {
        const thread = await ctx.bb.sdk.threads.get({ threadId });
        if (parentThreadId === thread.parentThreadId) return { ok: true };
        // Validate the parent before unpinning: a rejected update must keep the pin.
        await ctx.bb.sdk.threads.update({ threadId, parentThreadId });
        if (parentThreadId != null && thread.pinnedAt != null) {
          try {
            await ctx.bb.sdk.threads.unpin({ threadId });
          } catch (error) {
            ctx.bb.log.error(
              `Parent updated but unpinning failed for thread ${threadId}, parent ${parentThreadId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { ok: true, unpinFailed: true as const };
          }
        }
        return { ok: true };
      });
    },
    async deleteThread({ threadId, childThreadsConfirmed }) {
      // The sidebar shows its own confirmation naming the thread and project,
      // so bb's generic one is skipped. Deletion is recursive; bb refuses it
      // unless the caller confirmed the children too.
      await ctx.bb.sdk.threads.delete({ threadId, childThreadsConfirmed });
      return { ok: true };
    },
    regenerateTitle: ({ threadId }) => regenerateTitle(threadId),
    async getSidebarSettings() {
      return readSidebarSettings();
    },
    async updateSidebarSettings(values) {
      const stored = readSidebarSettings();
      const next = { ...stored, ...values };
      writeSidebarSettings(next);
      ctx.bb.realtime.publish(SIDEBAR_SETTINGS_CHANNEL, {});
      if (
        next.autoSettleInactive !== stored.autoSettleInactive ||
        next.autoSettleAfterDays !== stored.autoSettleAfterDays ||
        next.autoSettleOnMerge !== stored.autoSettleOnMerge
      ) {
        policy.settingsChanged();
        void evaluatePolicies().catch((error) => {
          ctx.bb.log.error(
            `Automatic settle evaluation failed after a settings change: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return readSidebarSettings();
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    async pin({ threadId }) {
      return withPinParentChange(threadId, async () => {
        const thread = await ctx.bb.sdk.threads.get({ threadId });
        if (thread.parentThreadId != null) {
          throw new Error("Child threads cannot be pinned");
        }
        // Preserve the previous shelf if the native pin fails.
        await ctx.bb.sdk.threads.pin({ threadId });
        write({
          threadId,
          parkedAt: null,
          settledAt: null,
          settledOverride: "active",
          snoozedUntil: null,
          snoozedAt: null,
        });
        return { ok: true };
      });
    },
    async park({ threadId }) {
      await ctx.bb.sdk.threads.unpin({ threadId });
      write({
        threadId,
        parkedAt: Date.now(),
        settledAt: null,
        settledOverride: null,
        snoozedUntil: null,
        snoozedAt: null,
      });
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async resume({ threadId }) {
      write({
        threadId,
        settledAt: null,
        settledOverride: "active",
        snoozedUntil: null,
        snoozedAt: null,
      });
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      await ctx.bb.sdk.threads.unpin({ threadId });
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        settledOverride: null,
        snoozedUntil,
        snoozedAt: now,
      });
      // A snooze is a parked thread with a return date, and the shortest
      // preset is half an hour. Nobody snoozes a conversation they are in the
      // middle of, so the wake time is not worth keeping a runtime warm for.
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async releaseRuntimes({ threadIds }) {
      // bb's archive force-closes a thread's terminals but only stops its
      // runtime when a turn is in flight, so an idle thread archived from this
      // sidebar keeps its agent session loaded. Stopping an idle thread takes
      // bb's release path instead. Archived threads still accept a stop, so
      // this can race the archive, and a failure only misses a reclaim.
      await runThreadTasks(
        threadIds,
        async (threadId) => {
          await ctx.bb.sdk.threads.stop({ threadId });
        },
        4,
      );
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async acknowledgeWake({ threadId }) {
      // A woken snooze row is retained only to make the marker durable. Once
      // the user opens or dismisses it, the thread is ordinary active work.
      clear(threadId);
      return { ok: true };
    },
    async reorderPinned({ threadId, previousThreadId, nextThreadId }) {
      const reordered = await ctx.bb.sdk.threads.reorderPinned({
        threadId,
        previousThreadId,
        nextThreadId,
      });
      return {
        pinnedThreadIds: reordered.filter((thread) => thread.pinnedAt !== null).map((thread) => thread.id),
      };
    },
    async listInboxOrder() {
      return { inboxThreadIds: readInboxOrder() };
    },
    async reorderInbox({ inboxThreadIds }) {
      replaceInboxOrder(inboxThreadIds);
      ctx.bb.realtime.publish(INBOX_ORDER_CHANNEL, {});
      return { inboxThreadIds: readInboxOrder() };
    },
    async evaluateAutoSettle() {
      return { changedThreadIds: await evaluatePolicies() };
    },
  } satisfies Pick<
    ServerHandlers,
    | "getOpenPorts"
    | "getThreadPorts"
    | "getThreadPullRequests"
    | "closeThreadPorts"
    | "stopWorkspacePort"
    | "getThreadExecutionDetails"
    | "setThreadParent"
    | "deleteThread"
    | "regenerateTitle"
    | "getSidebarSettings"
    | "updateSidebarSettings"
    | "listLifecycle"
    | "pin"
    | "park"
    | "resume"
    | "snooze"
    | "releaseRuntimes"
    | "unsnooze"
    | "acknowledgeWake"
    | "reorderPinned"
    | "listInboxOrder"
    | "reorderInbox"
    | "evaluateAutoSettle"
  >;

  return {
    ...cleanup.handlers,
    ...modules.settle.handlers,
    ...modules.colors.handlers,
    ...modules.icons.handlers,
    ...modules.projects.handlers,
    ...handlers,
  } satisfies ServerHandlers;
}
