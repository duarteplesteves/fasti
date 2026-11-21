import { Effect } from "effect";

import { definePlugin } from "../effect/index.js";
import type { PluginResourceId } from "../effect/index.js";
import { column } from "../index.js";

/** Refused by `notes.add` inside its unit, after the insert, so the unit rolls back. */
export interface NoteLimit {
  readonly _tag: "NoteLimit";
  readonly max: number;
}

/** A test-only third-party Plugin, written natively in Effect against public entry points only: notes on a Resource, at most `max` each. */
export function notes({ max }: { readonly max: number }) {
  return definePlugin({
    actions: {
      add: {
        kind: "write",
        run: (
          params: {
            readonly resourceId: PluginResourceId;
            readonly text: string;
          },
          { lock }
        ) =>
          lock(params.resourceId, ({ records }) =>
            Effect.gen(function* addNote() {
              const note = yield* records.note.insert({
                resourceId: params.resourceId,
                text: params.text,
              });

              const all = yield* records.note.list({
                resourceId: params.resourceId,
              });

              if (all.length > max) {
                return yield* Effect.fail<NoteLimit>({
                  _tag: "NoteLimit",
                  max,
                });
              }

              return { _tag: "Done", context: { note }, value: note } as const;
            })
          ),
      },
      list: {
        kind: "read",
        run: (params: { readonly resourceId: PluginResourceId }, { records }) =>
          records.note.list({ resourceId: params.resourceId }),
      },
    },
    name: "notes",
    tables: {
      note: { columns: { text: { required: true, type: column.text() } } },
    },
  });
}
