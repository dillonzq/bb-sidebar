import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPlugin } from "./test-server";

describe("lifecycle RPC", () => {
  it("returns no ports when no threads have environments", async () => {
    const harness = await loadPlugin();
    await expect(harness.behavior.callRpc("getOpenPorts", {})).resolves.toEqual({
      groups: [],
    });
  });

  it("returns only model and reasoning details, including unset options", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "default",
      source: "client/turn/start",
    }));
    await expect(
      harness.behavior.callRpc("getThreadExecutionDetails", {
        threadId: "thr_1",
      }),
    ).resolves.toEqual({ model: "gpt-6", reasoningLevel: "high" });
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => null);
    await expect(
      harness.behavior.callRpc("getThreadExecutionDetails", {
        threadId: "thr_1",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["models", "catalog-id", "gpt-6.1-sol", "gpt-6.1-sol", "GPT 6.1 Sol"],
    ["models", "custom-choice", "wire-model", "custom-choice", "My Custom Model"],
    ["selectedOnlyModels", "retired-model", "retired-model", "retired-model", "Retired Model"],
  ])(
    "resolves display names from %s in the thread's provider and environment",
    async (list, id, model, selected, name) => {
      const harness = await loadPlugin();
      harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
        model: selected,
        reasoningLevel: "medium",
      }));
      harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "thr_1", environmentId: "env_remote", providerId: "custom-provider" }),
      );
      harness.inspection.sdk.stub("providers.models", async (args) => {
        expect(args).toEqual({ environmentId: "env_remote", providerId: "custom-provider" });
        return {
          models: [],
          selectedOnlyModels: [],
          [list]: [{ id, model, displayName: name }],
        };
      });
      await expect(harness.behavior.callRpc("getThreadExecutionDetails", { threadId: "thr_1" })).resolves.toEqual({
        model: selected,
        modelDisplayName: name,
        reasoningLevel: "medium",
      });
    },
  );

  it.each(["missing", "blank", "offline"])("keeps raw execution details when the model name is %s", async (mode) => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "unknown-model",
      reasoningLevel: "high",
    }));
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ environmentId: "env_1" }));
    harness.inspection.sdk.stub("providers.models", async () => {
      if (mode === "offline") throw new Error("Host offline");
      return {
        models: [{ id: "unknown-model", model: "unknown-model", displayName: mode === "blank" ? "  " : "" }].filter(
          () => mode === "blank",
        ),
        selectedOnlyModels: [],
      };
    });
    await expect(harness.behavior.callRpc("getThreadExecutionDetails", { threadId: "thr_1" })).resolves.toEqual({
      model: "unknown-model",
      reasoningLevel: "high",
    });
  });
});
