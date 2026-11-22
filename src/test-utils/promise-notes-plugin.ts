import { column, definePlugin, ok } from "../index.js";
import type { PluginResourceId } from "../index.js";
import type { NoteLimit } from "./notes-plugin.js";

/** The test-only `notes` Plugin written with the Promise face, against the root entry point only: it behaves as `notes` does (I9). */
export function promiseNotes({ max }: { readonly max: number }) {
  return definePlugin({
    actions: {
      add: {
        kind: "write",
        run: async (
          params: {
            readonly resourceId: PluginResourceId;
            readonly text: string;
          },
          { lock }
        ) =>
          await lock(params.resourceId, async ({ records }) => {
            const note = await records.note.insert({
              resourceId: params.resourceId,
              text: params.text,
            });

            const all = await records.note.list({
              resourceId: params.resourceId,
            });

            if (all.length > max) {
              const error: NoteLimit = { _tag: "NoteLimit", max };

              return { _tag: "Failed", error } as const;
            }

            return { _tag: "Done", context: { note }, value: note } as const;
          }),
      },
      list: {
        kind: "read",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { records }
        ) => ok(await records.note.list({ resourceId: params.resourceId })),
      },
    },
    name: "notes",
    tables: {
      note: {
        columns: { text: { required: true, type: column.text() } },
        timed: false,
      },
    },
  });
}
